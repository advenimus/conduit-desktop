// The website hands its verified session over a conduit:// link; the secret is kept in safeStorage.

import { Account, AppwriteException, Client, type Models } from 'node-appwrite';
import { net, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { readSettings } from '../../ipc/settings.js';
import { ConduitDb, type Transport } from '../backend/conduit-db.js';
import type { RealtimeOptions } from '../backend/realtime.js';
import { directFiles, functionTransport } from '../backend/transport.js';
import { SUPPORT_EMAIL } from '../constants.js';
import { getDataDir, getEnvConfig, isLocalBackend } from '../env-config.js';
import { AppState } from '../state.js';
import { checkCachedTier } from './tier-cache.js';

export interface AuthUser {
  id: string;
  email: string;
  email_confirmed_at: string | null;
  created_at: string;
}

export interface UserProfile {
  id: string;
  display_name: string | null;
  tier_id: string | null;
  is_team_member: boolean;
  subscription_status?: string;
  trial_ends_at?: string;
  has_used_trial?: boolean;
  tier?: {
    name: string;
    display_name: string;
    features: Record<string, unknown>;
  };
  created_at: string;
  updated_at: string;
}

export type AuthMode = 'authenticated' | 'cached' | 'local';

export type MfaStatus = 'enrollment_required' | 'verification_required' | null;

export interface AuthState {
  user: AuthUser | null;
  profile: UserProfile | null;
  isAuthenticated: boolean;
  emailConfirmed: boolean;
  authMode?: AuthMode;
  mfaStatus?: MfaStatus;
  mfaFactorId?: string | null;
  signOutReason?: string | null;
}

interface SavedSession {
  session_secret: string;
  /** ISO time the Appwrite session expires. */
  expire: string | null;
  user: AuthUser;
}

const SIGNED_OUT: AuthState = {
  user: null,
  profile: null,
  isAuthenticated: false,
  emailConfirmed: false,
  mfaStatus: null,
  mfaFactorId: null,
};

const MFA_REQUIRED_REASON = 'Two-factor authentication is now required. Please sign in again to set up MFA.';
const JWT_REUSE_MS = 10 * 60 * 1000;

const isMoreFactorsRequired = (e: unknown) => e instanceof AppwriteException && e.type === 'user_more_factors_required';
const isUnauthorized = (e: unknown) => e instanceof AppwriteException && (e.code === 401 || e.code === 403) && !isMoreFactorsRequired(e);

function authUserFrom(user: Models.User<Models.Preferences>): AuthUser {
  return {
    id: user.$id,
    email: user.email,
    email_confirmed_at: user.emailVerification ? user.registration : null,
    created_at: user.registration,
  };
}

export class AuthService {
  private currentState: AuthState = { ...SIGNED_OUT };
  private readonly sessionFilePath: string;
  private initPromise: Promise<AuthState> | null = null;
  private hasLoggedNoSession = false;
  private stateChangeCallbacks: Array<(state: AuthState) => void> = [];
  private initialized = false;
  private initializedCallbacks: Array<(state: AuthState) => void> = [];
  private readonly isLocalBackend: boolean;
  private sessionSecret: string | null = null;
  private sessionExpire: string | null = null;
  private client: Client | null = null;
  private transport: Transport | null = null;
  private jwt: { value: string; at: number } | null = null;
  private readonly db: ConduitDb;

  constructor() {
    this.isLocalBackend = isLocalBackend(getEnvConfig());
    this.sessionFilePath = path.join(getDataDir(), 'conduit-auth-session.enc');
    // One client for the app's lifetime; each call uses whatever session is current.
    this.db = new ConduitDb(async (body, signal) => {
      if (!this.transport) {
        return { status: 401, body: JSON.stringify({ data: null, error: { code: '28000', message: 'not authenticated', details: null, hint: null } }) };
      }
      return this.transport(body, signal);
    }, directFiles(() => this.client));
  }

  private useSession(secret: string | null, expire: string | null = null): void {
    this.sessionSecret = secret;
    this.sessionExpire = expire;
    this.jwt = null;
    if (!secret) {
      this.client = null;
      this.transport = null;
      return;
    }
    const config = getEnvConfig();
    this.client = new Client().setEndpoint(config.appwriteEndpoint).setProject(config.appwriteProjectId).setSession(secret);
    this.transport = functionTransport(this.client);
  }

  private account(): Account {
    if (!this.client) throw new Error('not signed in');
    return new Account(this.client);
  }

  /** Initialize auth from the persisted session. Guarded against concurrent calls. */
  async initialize(): Promise<AuthState> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInitialize();
    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
      this.markInitialized();
    }
  }

  /** True once the first initialize() has finished (it clears its promise, so it cannot be awaited later). */
  hasInitialized(): boolean {
    return this.initialized;
  }

  /** Runs once, when the first initialize() finishes; at once when it already has. */
  onInitialized(cb: (state: AuthState) => void): void {
    if (this.initialized) cb(this.currentState);
    else this.initializedCallbacks.push(cb);
  }

  private markInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    const callbacks = this.initializedCallbacks;
    this.initializedCallbacks = [];
    for (const cb of callbacks) {
      try {
        cb(this.currentState);
      } catch (err) {
        console.error('[auth] an initialized listener failed', { name: err instanceof Error ? err.name : 'Error' });
      }
    }
  }

  private sessionStillValid(saved: SavedSession): boolean {
    return saved.expire === null || Date.parse(saved.expire) > Date.now();
  }

  private cachedState(saved: SavedSession): AuthState {
    return {
      user: saved.user,
      profile: this.currentState.profile,
      isAuthenticated: false,
      emailConfirmed: !!saved.user.email_confirmed_at,
      authMode: 'cached',
      mfaStatus: null,
      mfaFactorId: null,
    };
  }

  private offlineState(saved: SavedSession): AuthState | null {
    if (this.sessionStillValid(saved)) return this.cachedState(saved);
    if (this.loadCachedTierCapabilities()) return this.cachedState(saved);
    return null;
  }

  private async _doInitialize(): Promise<AuthState> {
    const saved = this.loadPersistedSession();

    if (!saved) {
      if (!this.hasLoggedNoSession) {
        console.log('[auth] No persisted session found');
        this.hasLoggedNoSession = true;
      }
      this.currentState = { ...SIGNED_OUT };
      // Fire callbacks so the MCP gatekeeper starts the socket in local mode.
      this.notifyRenderer();
      return this.currentState;
    }

    this.useSession(saved.session_secret, saved.expire);

    if (!net.isOnline()) {
      console.log('[auth] Offline, using the persisted session');
      this.currentState = this.offlineState(saved) ?? { ...SIGNED_OUT };
      return this.currentState;
    }

    console.log('[auth] Found persisted session, restoring...');
    try {
      return await Promise.race([
        this.restoreSession(saved),
        new Promise<AuthState>((_, reject) => setTimeout(() => reject(new Error('Session restore timed out')), 10_000)),
      ]);
    } catch (err) {
      console.warn('[auth] Failed to initialize:', err instanceof Error ? err.message : err);
      const offline = this.offlineState(saved);
      if (offline) {
        console.log('[auth] Using cached auth state');
        this.currentState = offline;
        return this.currentState;
      }
      this.deletePersistedSession();
      this.useSession(null);
      this.currentState = { ...SIGNED_OUT };
      return this.currentState;
    }
  }

  private async restoreSession(saved: SavedSession): Promise<AuthState> {
    let user: Models.User<Models.Preferences>;
    try {
      user = await this.account().get();
    } catch (err) {
      if (isMoreFactorsRequired(err)) {
        this.currentState = { ...SIGNED_OUT, user: saved.user, emailConfirmed: !!saved.user.email_confirmed_at, mfaStatus: 'verification_required' };
        return this.currentState;
      }
      if (isUnauthorized(err)) {
        console.warn('[auth] Saved session is no longer valid');
        this.deletePersistedSession();
        this.useSession(null);
        this.currentState = { ...SIGNED_OUT };
        return this.currentState;
      }
      throw err;
    }
    return this.adoptUser(user, 'session_restore');
  }

  /** Builds the signed-in state for a verified Appwrite user, enforcing the production MFA rule. */
  private async adoptUser(user: Models.User<Models.Preferences>, event: 'login' | 'registration' | 'session_restore'): Promise<AuthState> {
    // MFA is mandatory in production. A local stack skips it so developers need no authenticator app.
    if (!this.isLocalBackend && !user.mfa) {
      console.log('[auth] User has no MFA set up, signing out to enforce enrollment');
      await this.signOut(MFA_REQUIRED_REASON);
      return this.currentState;
    }
    const authUser = authUserFrom(user);
    this.persistSession({ session_secret: this.sessionSecret!, expire: this.sessionExpire, user: authUser });
    const profile = await this.fetchProfile(authUser.id);
    const confirmed = !!authUser.email_confirmed_at;
    this.currentState = {
      user: authUser,
      profile,
      isAuthenticated: confirmed,
      emailConfirmed: confirmed,
      authMode: confirmed ? 'authenticated' : undefined,
      mfaStatus: null,
      mfaFactorId: null,
    };
    this.submitFingerprintInBackground(event);
    console.log('[auth] Signed in — isAuthenticated:', this.currentState.isAuthenticated);
    this.notifyRenderer();
    return this.currentState;
  }

  /** Sign out the current user. */
  async signOut(reason?: string): Promise<void> {
    if (this.client) {
      await this.account().deleteSession({ sessionId: 'current' }).catch((err) => {
        console.warn('[auth] Server sign-out failed (continuing):', err instanceof Error ? err.message : err);
      });
    }
    this.deletePersistedSession();
    this.useSession(null);
    this.currentState = { ...SIGNED_OUT, signOutReason: reason ?? null };
    this.notifyRenderer();
  }

  /** MFA state of the current session (verification itself happens on the website). */
  async getMfaStatus(): Promise<{ mfaStatus: MfaStatus; factorId?: string }> {
    if (this.isLocalBackend || !this.client) return { mfaStatus: null };
    try {
      await this.account().get();
      return { mfaStatus: null };
    } catch (err) {
      if (isMoreFactorsRequired(err)) return { mfaStatus: 'verification_required' };
      console.error('[auth] Failed to read MFA status:', err instanceof Error ? err.message : err);
      throw new Error('Unable to verify MFA status. Please try again.');
    }
  }

  /** The current auth state (in memory, no network). */
  getAuthState(): AuthState {
    return this.currentState;
  }

  /** Register a callback that fires on every auth state change (e.g. McpGatekeeper). */
  onStateChange(cb: (state: AuthState) => void): void {
    this.stateChangeCallbacks.push(cb);
  }

  /** Data access through the api function, as the signed-in user. */
  getDb(): ConduitDb {
    return this.db;
  }

  /** What a Realtime subscription needs, or null when signed out. */
  getRealtimeOptions(): RealtimeOptions | null {
    if (!this.sessionSecret) return null;
    const config = getEnvConfig();
    return { endpoint: config.appwriteEndpoint, projectId: config.appwriteProjectId, sessionSecret: this.sessionSecret };
  }

  /** Short-lived JWT for calls to the website API, or null when signed out. */
  async getAccessToken(): Promise<string | null> {
    if (!this.sessionSecret) return null;
    if (this.jwt && Date.now() - this.jwt.at < JWT_REUSE_MS) return this.jwt.value;
    try {
      // The server SDK has no JWT call; this is the REST route the web SDK uses.
      const config = getEnvConfig();
      const res = await fetch(`${config.appwriteEndpoint}/account/jwts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Appwrite-Project': config.appwriteProjectId, 'X-Appwrite-Session': this.sessionSecret },
        body: '{}',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { jwt } = (await res.json()) as { jwt: string };
      this.jwt = { value: jwt, at: Date.now() };
      return jwt;
    } catch (err) {
      console.warn('[auth] Could not create a JWT:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  async getUserProfile(): Promise<UserProfile | null> {
    const userId = this.currentState.user?.id;
    return userId ? this.fetchProfile(userId) : null;
  }

  private async fetchProfile(userId: string): Promise<UserProfile | null> {
    if (!this.client) return null;
    const { data, error } = await this.db
      .from('user_profiles')
      .select(`
        id, display_name, tier_id, is_team_member, created_at, updated_at,
        subscription_status, trial_ends_at, has_used_trial,
        tier:tiers ( name, display_name, features )
      `)
      .eq('id', userId)
      .single();
    if (error || !data) {
      console.warn('[auth] Failed to fetch profile:', error?.message ?? 'no row');
      return null;
    }
    return {
      id: data.id,
      display_name: data.display_name,
      tier_id: data.tier_id,
      is_team_member: data.is_team_member,
      subscription_status: data.subscription_status ?? undefined,
      trial_ends_at: data.trial_ends_at ?? undefined,
      has_used_trial: data.has_used_trial ?? undefined,
      tier: data.tier ?? undefined,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  }

  /**
   * Reads the profile (plan) again into the auth state, without notifying listeners. Checks that
   * must see a plan change (cloud backup, spec 8.2) call this first. A failed read keeps the old profile.
   */
  async reloadProfile(): Promise<UserProfile | null> {
    const userId = this.currentState.user?.id;
    if (!userId) return null;
    const profile = await this.getUserProfile();
    if (profile === null || profile.id !== userId || this.currentState.user?.id !== userId) return null;
    this.currentState = { ...this.currentState, profile };
    return profile;
  }

  /** Re-reads the account and profile. */
  async refreshSession(): Promise<AuthState> {
    if (!this.client) return this.currentState;
    try {
      const user = await this.account().get();
      const authUser = authUserFrom(user);
      const profile = (await this.fetchProfile(authUser.id)) ?? this.currentState.profile;
      const confirmed = !!authUser.email_confirmed_at;
      this.currentState = { ...this.currentState, user: authUser, profile, emailConfirmed: confirmed, isAuthenticated: confirmed, authMode: confirmed ? 'authenticated' : this.currentState.authMode };
    } catch (err) {
      console.warn('[auth] Failed to refresh session:', err instanceof Error ? err.message : err);
    }
    return this.currentState;
  }

  /** Resend the email confirmation for the signed-in account. */
  async resendConfirmation(_email: string): Promise<void> {
    if (!this.client) throw 'Sign in again to resend the confirmation email.';
    try {
      await this.account().createVerification({ url: `${getEnvConfig().websiteUrl}/auth/verify` });
    } catch (err) {
      throw err instanceof Error ? err.message : String(err);
    }
  }

  /** Session handed over by the website (conduit://auth/callback#user_id=...&session=...). */
  async handleDeepLinkSession(userId: string, sessionSecret: string): Promise<void> {
    console.log('[auth] Session handoff received, secret length:', sessionSecret.length);
    const previous = { secret: this.sessionSecret, expire: this.sessionExpire };
    this.useSession(sessionSecret, null);
    try {
      const user = await this.account().get();
      if (user.$id !== userId) throw new Error('session belongs to another user');
      try {
        const session = await this.account().getSession({ sessionId: 'current' });
        this.sessionExpire = session.expire;
      } catch {
        // The expiry only helps offline start-up; the server stays the judge.
      }
      // The website handoff is what the old backend scored as a registration.
      await this.adoptUser(user, 'registration');
    } catch (err) {
      if (isMoreFactorsRequired(err)) {
        console.warn('[auth] Handed-over session still needs its second step');
      } else {
        console.error('[auth] Failed to adopt the handed-over session:', err instanceof Error ? err.message : err);
      }
      this.useSession(previous.secret, previous.expire);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  /** Device fingerprint and abuse check, in the background. Signs out a suspended account. */
  private submitFingerprintInBackground(eventType: 'login' | 'registration' | 'session_restore'): void {
    import('./fingerprint.js')
      .then(async ({ collectFingerprint }) => {
        const fp = collectFingerprint();
        const { data, error } = await this.db.rpc<{ abuse_score: number; suspended: boolean }>('submit_fingerprint', { ...fp, event_type: eventType });
        if (error || !data) throw new Error(error?.message ?? 'no answer');
        return data;
      })
      .then((result) => {
        if (result.suspended) {
          console.error('[auth] Account suspended by abuse detection');
          this.signOut(`Your account has been suspended. Please contact ${SUPPORT_EMAIL} for assistance.`);
        } else if (result.abuse_score > 0) {
          console.warn('[auth] Abuse score:', result.abuse_score);
        }
      })
      .catch((err) => {
        console.error('[auth] Fingerprint submission failed (non-blocking):', err?.message ?? err);
      });
  }

  /**
   * Cached tier capabilities from settings. Null when missing, older than 7 days, or dated more than
   * 5 minutes in the future (spec 6.8).
   */
  private loadCachedTierCapabilities(): Record<string, unknown> | null {
    try {
      const verdict = checkCachedTier(readSettings(), Date.now());
      if (verdict.ok) return { ...verdict.capabilities };
      if (verdict.reason !== 'missing') console.log(`[auth] Cached tier ignored (${verdict.reason})`);
      return null;
    } catch (err) {
      console.warn('[auth] Cached tier unreadable:', (err as Error)?.message ?? err);
      return null;
    }
  }

  private persistSession(saved: SavedSession): void {
    try {
      const data = JSON.stringify(saved);
      fs.mkdirSync(path.dirname(this.sessionFilePath), { recursive: true });
      if (safeStorage.isEncryptionAvailable()) {
        fs.writeFileSync(this.sessionFilePath, safeStorage.encryptString(data));
      } else {
        fs.writeFileSync(this.sessionFilePath, data, 'utf-8');
      }
    } catch (err) {
      console.warn('[auth] Failed to persist session:', err);
    }
  }

  /** The saved session, or null when missing, unreadable, or written by a build from before the move to Appwrite. */
  private loadPersistedSession(): SavedSession | null {
    try {
      if (!fs.existsSync(this.sessionFilePath)) return null;
      const raw = fs.readFileSync(this.sessionFilePath);
      const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf-8');
      const parsed = JSON.parse(json) as Partial<SavedSession>;
      if (typeof parsed.session_secret !== 'string' || !parsed.user?.id) return null;
      return { session_secret: parsed.session_secret, expire: parsed.expire ?? null, user: parsed.user };
    } catch (err) {
      console.warn('[auth] Failed to load persisted session:', err);
      return null;
    }
  }

  private deletePersistedSession(): void {
    try {
      if (fs.existsSync(this.sessionFilePath)) fs.unlinkSync(this.sessionFilePath);
    } catch (err) {
      console.warn('[auth] Failed to delete persisted session:', err);
    }
  }

  private notifyRenderer(): void {
    const win = AppState.getInstance().getMainWindow();
    if (win) win.webContents.send('auth:state-changed', this.currentState);
    for (const cb of this.stateChangeCallbacks) {
      try {
        cb(this.currentState);
      } catch (err) {
        console.error('[auth] State change callback error:', err);
      }
    }
  }
}
