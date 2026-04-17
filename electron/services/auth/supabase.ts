/**
 * Supabase authentication service for the Electron main process.
 *
 * Handles user registration, login, session persistence, and profile management.
 * Sessions are encrypted using Electron's safeStorage API.
 */

import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import { app, net, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { readSettings } from '../../ipc/settings.js';
import { SUPPORT_EMAIL } from '../constants.js';
import { getEnvConfig, getDataDir } from '../env-config.js';
import { AppState } from '../state.js';

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

export class AuthService {
  private supabase: SupabaseClient;
  private currentState: AuthState;
  private sessionFilePath: string;
  private initPromise: Promise<AuthState> | null = null;
  private pendingSignOutReason: string | null = null;
  private hasLoggedNoSession = false;
  private stateChangeCallbacks: Array<(state: AuthState) => void> = [];
  private readonly isLocalSupabase: boolean;

  constructor() {
    const envConfig = getEnvConfig();
    this.isLocalSupabase = envConfig.supabaseUrl.includes('127.0.0.1') || envConfig.supabaseUrl.includes('localhost');
    this.supabase = createClient(envConfig.supabaseUrl, envConfig.supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });

    this.currentState = {
      user: null,
      profile: null,
      isAuthenticated: false,
      emailConfirmed: false,
      mfaStatus: null,
      mfaFactorId: null,
    };

    this.sessionFilePath = path.join(getDataDir(), 'conduit-auth-session.enc');

    // Listen for auth state changes
    // IMPORTANT: This callback must NOT await Supabase client calls (getUser, etc.)
    // because Supabase awaits all onAuthStateChange callbacks before setSession returns,
    // creating a deadlock if the callback calls back into the client.
    this.supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        const reason = this.pendingSignOutReason;
        this.pendingSignOutReason = null;
        this.currentState = {
          user: null,
          profile: null,
          isAuthenticated: false,
          emailConfirmed: false,
          mfaStatus: null,
          mfaFactorId: null,
          signOutReason: reason,
        };
        this.deletePersistedSession();
        this.notifyRenderer();
      } else if (session) {
        // Only persist sessions for confirmed users to avoid broken session files
        if (session.user?.email_confirmed_at) {
          this.persistSession(session);
        }
        // Build state from session data directly (no network calls) to avoid deadlock
        // Preserve mfaStatus/mfaFactorId — can't call async MFA methods inside this callback
        const user = session.user;
        this.currentState = {
          user: {
            id: user.id,
            email: user.email ?? '',
            email_confirmed_at: user.email_confirmed_at ?? null,
            created_at: user.created_at,
          },
          profile: this.currentState.profile, // keep existing profile
          isAuthenticated: !!user.email_confirmed_at && !this.currentState.mfaStatus,
          emailConfirmed: !!user.email_confirmed_at,
          authMode: this.currentState.authMode, // preserve current auth mode
          mfaStatus: this.currentState.mfaStatus,
          mfaFactorId: this.currentState.mfaFactorId,
        };
        this.notifyRenderer();
        // Fetch profile in the background — deferred to next tick to avoid
        // deadlocking on Supabase's internal auth lock held by setSession.
        setTimeout(() => {
          this.getUserProfile().then((profile) => {
            // Skip update if profile fetch returned null (network error) — keep existing profile
            if (!profile) return;
            this.currentState = { ...this.currentState, profile };
            this.notifyRenderer();
          }).catch(() => { /* profile fetch is best-effort */ });
        }, 0);
      }
    });
  }

  /**
   * Initialize auth from persisted session. Call on app startup.
   * Guarded against concurrent calls (e.g. React StrictMode double-mount).
   */
  async initialize(): Promise<AuthState> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInitialize();
    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async _doInitialize(): Promise<AuthState> {
    const unauthenticated: AuthState = {
      user: null,
      profile: null,
      isAuthenticated: false,
      emailConfirmed: false,
      mfaStatus: null,
      mfaFactorId: null,
    };

    const session = this.loadPersistedSession();

    // Fast offline detection — skip Supabase network calls entirely
    if (!net.isOnline()) {
      if (!session) {
        if (!this.hasLoggedNoSession) {
          console.log('[auth] No persisted session found (offline)');
          this.hasLoggedNoSession = true;
        }
        this.currentState = unauthenticated;
        // Fire callbacks so the MCP gatekeeper starts the socket in local mode.
        this.notifyRenderer();
        return this.currentState;
      }

      console.log('[auth] Offline detected, using fast path for persisted session');

      if (this.isTokenNotExpired(session.access_token)) {
        console.log('[auth] Using cached auth state (offline, token not expired)');
        this.currentState = this.buildCachedAuthState(session);
        return this.currentState;
      }

      const cachedTier = this.loadCachedTierCapabilities();
      if (cachedTier && session.user) {
        console.log('[auth] Token expired but cached tier available (offline)');
        this.currentState = {
          user: {
            id: session.user.id,
            email: session.user.email,
            email_confirmed_at: session.user.email_confirmed_at ?? null,
            created_at: session.user.created_at,
          },
          profile: null,
          isAuthenticated: false,
          emailConfirmed: !!session.user.email_confirmed_at,
          authMode: 'cached',
          mfaStatus: null,
          mfaFactorId: null,
        };
        return this.currentState;
      }

      // Expired token + no cache — can't verify identity, but preserve session file for next online launch
      console.log('[auth] Offline with expired token and no cached tier');
      this.currentState = unauthenticated;
      return this.currentState;
    }

    if (!session) {
      if (!this.hasLoggedNoSession) {
        console.log('[auth] No persisted session found');
        this.hasLoggedNoSession = true;
      }
      this.currentState = unauthenticated;
      // Fire callbacks so the MCP gatekeeper evaluates access for local mode
      // (otherwise the IPC socket never starts when there's no session).
      this.notifyRenderer();
      return this.currentState;
    }

    console.log('[auth] Found persisted session, restoring...');

    // Wrap entire session restoration in a timeout to prevent hanging
    const timeoutMs = 10000;
    try {
      const result = await Promise.race([
        this.restoreSession(session),
        new Promise<AuthState>((_, reject) =>
          setTimeout(() => reject(new Error('Session restore timed out')), timeoutMs)
        ),
      ]);
      return result;
    } catch (err) {
      console.warn('[auth] Failed to initialize:', err);
      // If token is still valid, use cached state for offline access
      if (this.isTokenNotExpired(session.access_token)) {
        console.log('[auth] Using cached auth state (token not expired)');
        this.currentState = this.buildCachedAuthState(session);
        return this.currentState;
      }
      // Token expired — check for cached tier capabilities for offline degraded mode
      const cachedTier = this.loadCachedTierCapabilities();
      if (cachedTier && session.user) {
        console.log('[auth] Token expired but cached tier available, entering cached mode');
        this.currentState = {
          user: {
            id: session.user.id,
            email: session.user.email,
            email_confirmed_at: session.user.email_confirmed_at ?? null,
            created_at: session.user.created_at,
          },
          profile: this.currentState.profile,
          isAuthenticated: false,
          emailConfirmed: !!session.user.email_confirmed_at,
          authMode: 'cached',
          mfaStatus: null,
          mfaFactorId: null,
        };
        return this.currentState;
      }
      this.deletePersistedSession();
      this.currentState = unauthenticated;
      return this.currentState;
    }
  }

  /** Attempt to restore a persisted session with Supabase */
  private async restoreSession(session: { access_token: string; refresh_token: string; user?: { id: string; email: string; email_confirmed_at?: string; created_at: string } }): Promise<AuthState> {
    console.log('[auth] Calling setSession...');
    const { data, error } = await this.supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    console.log('[auth] setSession returned — error:', error?.message ?? 'none', 'hasSession:', !!data.session);

    if (error || !data.session) {
      if (this.isTokenNotExpired(session.access_token)) {
        console.log('[auth] Network error but token not expired, using cached state');
        this.currentState = this.buildCachedAuthState(session);
        return this.currentState;
      }
      console.warn('[auth] Failed to restore session:', error?.message);
      this.deletePersistedSession();
      this.currentState = {
        user: null,
        profile: null,
        isAuthenticated: false,
        emailConfirmed: false,
        mfaStatus: null,
        mfaFactorId: null,
      };
      return this.currentState;
    }

    console.log('[auth] Building auth state...');
    this.currentState = await this.buildAuthState(data.session);

    // MFA is mandatory in production. Local-Supabase dev bypasses this
    // so developers don't need an authenticator app to iterate.
    if (this.currentState.isAuthenticated && !this.isLocalSupabase) {
      const { data: factorsData } = await this.supabase.auth.mfa.listFactors();
      const verifiedFactors = factorsData?.totp?.filter(f => f.status === 'verified') ?? [];
      if (verifiedFactors.length === 0) {
        console.log('[auth] User has no MFA factors enrolled, signing out to enforce enrollment');
        await this.signOut('Two-factor authentication is now required. Please sign in again to set up MFA.');
        return this.currentState;
      }
    }

    this.submitFingerprintInBackground(data.session.access_token, 'session_restore');
    console.log('[auth] Initialize complete — isAuthenticated:', this.currentState.isAuthenticated);
    return this.currentState;
  }

  /**
   * Sign out the current user.
   */
  async signOut(reason?: string): Promise<void> {
    this.pendingSignOutReason = reason ?? null;
    await this.supabase.auth.signOut();
    this.deletePersistedSession();
    this.currentState = {
      user: null,
      profile: null,
      isAuthenticated: false,
      emailConfirmed: false,
      mfaStatus: null,
      mfaFactorId: null,
      signOutReason: reason ?? null,
    };
    this.pendingSignOutReason = null;
    this.notifyRenderer();
  }

  // ── MFA Methods ──────────────────────────────────────────────────

  /**
   * Check the current MFA assurance level.
   * Returns mfaStatus and optional factorId for verification.
   */
  async getMfaStatus(): Promise<{ mfaStatus: MfaStatus; factorId?: string }> {
    // Local-Supabase dev never requires MFA. Production behaves normally.
    if (this.isLocalSupabase) {
      return { mfaStatus: null };
    }
    const { data, error } = await this.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) {
      console.error('[auth] Failed to get MFA assurance level:', error.message);
      throw new Error('Unable to verify MFA status. Please try again.');
    }

    if (data.currentLevel === 'aal2') {
      // Fully authenticated with MFA
      return { mfaStatus: null };
    }

    if (data.nextLevel === 'aal2') {
      // Has verified TOTP factors — needs to verify code
      const verifiedFactor = data.currentAuthenticationMethods.length > 0
        ? (await this.supabase.auth.mfa.listFactors()).data?.totp?.find(f => f.status === 'verified')
        : undefined;
      return {
        mfaStatus: 'verification_required',
        factorId: verifiedFactor?.id,
      };
    }

    // nextLevel is aal1 — MFA not configured/required for this user
    return { mfaStatus: null };
  }

  /**
   * Get the current auth state (in-memory, no network).
   */
  getAuthState(): AuthState {
    return this.currentState;
  }

  /**
   * Register a callback that fires on every auth state change.
   * Used by McpGatekeeper to react to sign-in, sign-out, and profile loads.
   */
  onStateChange(cb: (state: AuthState) => void): void {
    this.stateChangeCallbacks.push(cb);
  }

  /**
   * Get the current Supabase JWT access token for authenticated backend API calls.
   * Returns null if no session is active.
   */
  async getAccessToken(): Promise<string | null> {
    const { data } = await this.supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }

  /**
   * Get the underlying Supabase client (for Storage API access, etc.).
   */
  getSupabaseClient(): SupabaseClient {
    return this.supabase;
  }

  /**
   * Fetch the user profile from Supabase.
   */
  async getUserProfile(): Promise<UserProfile | null> {
    try {
      const { data: { user } } = await this.supabase.auth.getUser();
      if (!user) return null;

      const { data, error } = await this.supabase
        .from('user_profiles')
        .select(`
          id, display_name, tier_id, is_team_member, created_at, updated_at,
          subscription_status, trial_ends_at, has_used_trial,
          tier:tiers ( name, display_name, features )
        `)
        .eq('id', user.id)
        .single();

      if (error) {
        console.warn('[auth] Failed to fetch profile:', error.message);
        return null;
      }

      // Supabase returns joined tier as array or object
      const tierData = Array.isArray(data.tier) ? data.tier[0] : data.tier;

      return {
        id: data.id,
        display_name: data.display_name,
        tier_id: data.tier_id,
        is_team_member: data.is_team_member,
        subscription_status: data.subscription_status ?? undefined,
        trial_ends_at: data.trial_ends_at ?? undefined,
        has_used_trial: data.has_used_trial ?? undefined,
        tier: tierData ?? undefined,
        created_at: data.created_at,
        updated_at: data.updated_at,
      };
    } catch (err) {
      console.warn('[auth] Failed to fetch profile (network error):', (err as Error)?.message ?? err);
      return null;
    }
  }

  /**
   * Force refresh the current session.
   */
  async refreshSession(): Promise<AuthState> {
    const { data, error } = await this.supabase.auth.refreshSession();

    if (error || !data.session) {
      console.warn('[auth] Failed to refresh session:', error?.message);
      return this.currentState;
    }

    this.persistSession(data.session);
    this.currentState = await this.buildAuthState(data.session);
    // Ensure authMode is set to authenticated on successful refresh
    if (this.currentState.isAuthenticated && !this.currentState.authMode) {
      this.currentState.authMode = 'authenticated';
    }
    return this.currentState;
  }

  /**
   * Resend the email confirmation.
   */
  async resendConfirmation(email: string): Promise<void> {
    const { error } = await this.supabase.auth.resend({
      type: 'signup',
      email,
    });

    if (error) throw error.message;
  }

  /**
   * Handle tokens from a deep link callback (conduit://auth/callback#access_token=...).
   * Called by the main process when the OS opens a conduit:// URL.
   */
  async handleDeepLinkTokens(accessToken: string, refreshToken: string): Promise<void> {
    console.log('[auth] handleDeepLinkTokens called, access_token length:', accessToken.length, 'refresh_token:', refreshToken);

    const { data, error } = await this.supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (error) {
      console.error('[auth] Failed to set session from deep link:', error.message);
      return;
    }

    console.log('[auth] setSession result — session exists:', !!data.session, 'user:', data.session?.user?.email ?? 'none');

    if (data.session) {
      this.persistSession(data.session);
      this.currentState = await this.buildAuthState(data.session);

      // MFA is mandatory in production. Local-Supabase dev bypasses.
      if (this.currentState.isAuthenticated && !this.isLocalSupabase) {
        const { data: factorsData } = await this.supabase.auth.mfa.listFactors();
        const verifiedFactors = factorsData?.totp?.filter(f => f.status === 'verified') ?? [];
        if (verifiedFactors.length === 0) {
          console.log('[auth] Deep link user has no MFA factors, signing out to enforce enrollment');
          await this.signOut('Two-factor authentication is now required. Please sign in again to set up MFA.');
          return;
        }
      }

      this.submitFingerprintInBackground(data.session.access_token, 'registration');
      console.log('[auth] Deep link auth complete — isAuthenticated:', this.currentState.isAuthenticated, 'emailConfirmed:', this.currentState.emailConfirmed);
      this.notifyRenderer();
    } else {
      console.warn('[auth] setSession returned no error but also no session');
    }
  }

  /**
   * Get token usage data for the current user.
   * Reads directly from Supabase (RLS allows users to read their own row).
   */
  async getUsage(): Promise<{
    usage: {
      total_used: number;
      request_count: number;
      monthly_limit: number;
      monthly_remaining: number;
      monthly_resets_at: string;
      daily_used: number;
      daily_limit: number;
      daily_remaining: number;
      daily_resets_at: string;
    };
    tier: { name: string; display_name: string };
    is_team_member: boolean;
  } | null> {
    const { data: { user } } = await this.supabase.auth.getUser();
    if (!user) return null;

    // Fetch profile with tier
    const profile = await this.getUserProfile();
    if (!profile) return null;

    const isTeamMember = profile.is_team_member;
    const features = profile.tier?.features as Record<string, unknown> ?? {};
    const monthlyLimit = features.monthly_token_budget as number ?? 1000000;
    const dailyLimit = features.daily_token_budget as number ?? 200000;

    // Fetch budget data
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const today = now.toISOString().split('T')[0];

    const { data: budget } = await this.supabase
      .from('user_token_budgets')
      .select('*')
      .eq('user_id', user.id)
      .single();

    let totalUsed = 0;
    let requestCount = 0;
    let dailyUsed = 0;

    if (budget) {
      if (budget.period_year === year && budget.period_month === month) {
        totalUsed = Number(budget.input_tokens_used) + Number(budget.output_tokens_used);
        requestCount = budget.request_count;
      }
      if (budget.current_day === today) {
        dailyUsed = Number(budget.daily_input_tokens) + Number(budget.daily_output_tokens);
      }
    }

    const monthlyRemaining = monthlyLimit === -1 ? -1 : Math.max(0, monthlyLimit - totalUsed);
    const dailyRemaining = dailyLimit === -1 ? -1 : Math.max(0, dailyLimit - dailyUsed);
    const monthlyResetsAt = new Date(year, month, 1).toISOString();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);

    return {
      usage: {
        total_used: totalUsed,
        request_count: requestCount,
        monthly_limit: monthlyLimit,
        monthly_remaining: monthlyRemaining,
        monthly_resets_at: monthlyResetsAt,
        daily_used: dailyUsed,
        daily_limit: dailyLimit,
        daily_remaining: dailyRemaining,
        daily_resets_at: tomorrow.toISOString(),
      },
      tier: {
        name: profile.tier?.name ?? 'free',
        display_name: profile.tier?.display_name ?? 'Free',
      },
      is_team_member: isTeamMember,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Submit device fingerprint to the backend in the background.
   * Non-blocking: does not affect the auth flow. Auto-signs out on suspension.
   */
  private submitFingerprintInBackground(accessToken: string, eventType: 'login' | 'registration' | 'session_restore'): void {
    import('./fingerprint.js').then(({ collectFingerprint }) => {
      const fp = collectFingerprint();
      console.log(`[auth] Submitting fingerprint (${eventType}, hash: ${fp.fingerprint_hash.slice(0, 8)}...)`);
      return import('./backend.js').then(({ submitFingerprint }) =>
        submitFingerprint(accessToken, fp, eventType)
      );
    }).then((result) => {
      console.log(`[auth] Fingerprint submitted successfully (abuse_score: ${result.abuse_score}, suspended: ${result.suspended})`);
      if (result.suspended) {
        console.error('[auth] Account suspended by abuse detection');
        this.signOut(`Your account has been suspended. Please contact ${SUPPORT_EMAIL} for assistance.`);
      } else if (result.abuse_score > 0) {
        console.warn('[auth] Abuse score:', result.abuse_score);
      }
    }).catch((err) => {
      console.error('[auth] Fingerprint submission failed (non-blocking):', err?.message ?? err);
    });
  }

  private async buildAuthState(session: Session): Promise<AuthState> {
    const user = session.user;
    const profile = await this.getUserProfile();

    // Check MFA assurance level
    const mfa = await this.getMfaStatus();
    const isFullyAuthenticated = !!user.email_confirmed_at && !mfa.mfaStatus;

    return {
      user: {
        id: user.id,
        email: user.email ?? '',
        email_confirmed_at: user.email_confirmed_at ?? null,
        created_at: user.created_at,
      },
      profile,
      isAuthenticated: isFullyAuthenticated,
      emailConfirmed: !!user.email_confirmed_at,
      authMode: isFullyAuthenticated ? 'authenticated' : undefined,
      mfaStatus: mfa.mfaStatus,
      mfaFactorId: mfa.factorId ?? null,
    };
  }

  private buildCachedAuthState(session: { access_token: string; refresh_token: string; user?: { id: string; email: string; email_confirmed_at?: string; created_at: string } }): AuthState {
    if (!session.user) {
      return {
        user: null,
        profile: null,
        isAuthenticated: false,
        emailConfirmed: false,
        mfaStatus: null,
        mfaFactorId: null,
      };
    }
    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        email_confirmed_at: session.user.email_confirmed_at ?? null,
        created_at: session.user.created_at,
      },
      profile: this.currentState.profile, // keep cached profile
      isAuthenticated: false,
      emailConfirmed: !!session.user.email_confirmed_at,
      authMode: 'cached',
      mfaStatus: null,
      mfaFactorId: null,
    };
  }

  private isTokenNotExpired(accessToken: string): boolean {
    try {
      const parts = accessToken.split('.');
      if (parts.length !== 3) return false;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      const exp = payload.exp as number;
      return Date.now() / 1000 < exp;
    } catch {
      return false;
    }
  }

  /**
   * Load cached tier capabilities from settings. Returns null if stale (>7 days).
   */
  private loadCachedTierCapabilities(): Record<string, unknown> | null {
    try {
      const settings = readSettings();
      const caps = settings.cached_tier_capabilities;
      const timestamp = settings.cached_tier_timestamp;
      if (!caps || !timestamp) return null;
      const age = Date.now() - new Date(timestamp).getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (age > sevenDays) {
        console.log('[auth] Cached tier is stale (>7 days), ignoring');
        return null;
      }
      return caps as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private persistSession(session: Session): void {
    try {
      const data = JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        user: session.user ? {
          id: session.user.id,
          email: session.user.email,
          email_confirmed_at: session.user.email_confirmed_at,
          created_at: session.user.created_at,
        } : undefined,
      });

      // Ensure directory exists
      const dir = path.dirname(this.sessionFilePath);
      fs.mkdirSync(dir, { recursive: true });

      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(data);
        fs.writeFileSync(this.sessionFilePath, encrypted);
      } else {
        // Fallback to plain JSON (less secure)
        fs.writeFileSync(this.sessionFilePath, data, 'utf-8');
      }
    } catch (err) {
      console.warn('[auth] Failed to persist session:', err);
    }
  }

  private loadPersistedSession(): { access_token: string; refresh_token: string; user?: { id: string; email: string; email_confirmed_at?: string; created_at: string } } | null {
    try {
      if (!fs.existsSync(this.sessionFilePath)) return null;

      const raw = fs.readFileSync(this.sessionFilePath);

      let json: string;
      if (safeStorage.isEncryptionAvailable()) {
        json = safeStorage.decryptString(raw);
      } else {
        json = raw.toString('utf-8');
      }

      return JSON.parse(json);
    } catch (err) {
      console.warn('[auth] Failed to load persisted session:', err);
      return null;
    }
  }

  private deletePersistedSession(): void {
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        fs.unlinkSync(this.sessionFilePath);
      }
    } catch (err) {
      console.warn('[auth] Failed to delete persisted session:', err);
    }
  }

  private notifyRenderer(): void {
    const win = AppState.getInstance().getMainWindow();
    if (win) {
      win.webContents.send('auth:state-changed', this.currentState);
    }
    // Invoke registered state-change callbacks (e.g. McpGatekeeper)
    for (const cb of this.stateChangeCallbacks) {
      try {
        cb(this.currentState);
      } catch (err) {
        console.error('[auth] State change callback error:', err);
      }
    }
  }
}
