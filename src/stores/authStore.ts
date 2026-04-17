import { create } from 'zustand';
import { invoke } from '../lib/electron';
import type { AuthUser, UserProfile, AuthState, AuthMode, MfaStatus } from '../types/auth';

interface AuthStoreState {
  user: AuthUser | null;
  profile: UserProfile | null;
  isAuthenticated: boolean;
  emailConfirmed: boolean;
  authMode: AuthMode | null; // null = not resolved yet (shows auth screen)
  mfaStatus: MfaStatus;
  mfaFactorId: string | null;
  isInitializing: boolean;
  isLoading: boolean;
  error: string | null;
  /** Convenience: team ID from profile (null if not in a team). */
  teamId: string | null;
  /** Convenience: team membership flag from profile. */
  isTeamMember: boolean;

  initialize: () => Promise<void>;
  openLogin: () => void;
  openSignup: () => void;
  signOut: () => Promise<void>;
  loadProfile: () => Promise<void>;
  resendConfirmation: (email: string) => Promise<void>;
  enterLocalMode: () => void;
  exitToSignIn: () => void;
  enterCachedMode: () => void;
  tryReauthenticate: () => Promise<boolean>;
  clearError: () => void;
  handleAuthStateChanged: (state: AuthState) => void;
  refreshProfile: () => Promise<void>;
}

export const useAuthStore = create<AuthStoreState>((set, get) => ({
  user: null,
  profile: null,
  isAuthenticated: false,
  emailConfirmed: false,
  authMode: null,
  mfaStatus: null,
  mfaFactorId: null,
  teamId: null,
  isTeamMember: false,
  isInitializing: true,
  isLoading: false,
  error: null,

  initialize: async () => {
    try {
      const state = await invoke<AuthState>('auth_initialize');
      set({
        user: state.user,
        profile: state.profile,
        isAuthenticated: state.isAuthenticated,
        emailConfirmed: state.emailConfirmed,
        authMode: state.authMode ?? (state.isAuthenticated ? 'authenticated' : null),
        mfaStatus: state.mfaStatus ?? null,
        mfaFactorId: state.mfaFactorId ?? null,
        teamId: state.profile?.primary_team_id ?? null,
        isTeamMember: state.profile?.is_team_member ?? false,
        isInitializing: false,
      });
    } catch (err) {
      console.error('[auth] Failed to initialize:', err);
      set({ isInitializing: false });
    }
  },

  openLogin: () => {
    invoke('auth_open_login').catch((err) => {
      console.error('[auth] Failed to open login:', err);
    });
  },

  openSignup: () => {
    invoke('auth_open_signup').catch((err) => {
      console.error('[auth] Failed to open signup:', err);
    });
  },

  signOut: async () => {
    try {
      await invoke('auth_sign_out');
      set({
        user: null,
        profile: null,
        isAuthenticated: false,
        emailConfirmed: false,
        authMode: null,
        mfaStatus: null,
        mfaFactorId: null,
        teamId: null,
        isTeamMember: false,
        error: null,
      });
    } catch (err) {
      console.error('[auth] Failed to sign out:', err);
    }
  },

  loadProfile: async () => {
    try {
      const profile = await invoke<UserProfile>('auth_get_profile');
      set({
        profile,
        teamId: profile?.primary_team_id ?? null,
        isTeamMember: profile?.is_team_member ?? false,
      });
    } catch (err) {
      console.error('[auth] Failed to load profile:', err);
    }
  },

  refreshProfile: async () => {
    try {
      const newProfile = await invoke<UserProfile>('auth_get_profile');
      // If fetch returned null (network error / no session), keep current profile
      if (!newProfile) return;
      const currentProfile = get().profile;
      const tierChanged = currentProfile?.tier?.name !== newProfile?.tier?.name;
      set({
        profile: newProfile,
        teamId: newProfile?.primary_team_id ?? null,
        isTeamMember: newProfile?.is_team_member ?? false,
      });
      if (tierChanged) {
        document.dispatchEvent(new CustomEvent('conduit:tier-changed'));
      }
    } catch (err) {
      console.error('[auth] Failed to refresh profile:', err);
    }
  },

  resendConfirmation: async (email: string) => {
    set({ error: null });
    try {
      await invoke('auth_resend_confirmation', { email });
    } catch (err) {
      set({
        error: typeof err === 'string' ? err : 'Failed to resend confirmation',
      });
      throw err;
    }
  },

  enterLocalMode: () => {
    invoke('auth_set_local_mode').catch(() => {}); // persist choice
    set({
      authMode: 'local',
      isInitializing: false,
      isAuthenticated: false,
      user: null,
      profile: null,
      teamId: null,
      isTeamMember: false,
    });
  },

  exitToSignIn: () => {
    set({
      authMode: null,
      isAuthenticated: false,
      error: null,
    });
  },

  enterCachedMode: () => {
    const { authMode } = get();
    if (authMode !== 'authenticated') return;
    console.log('[auth] Network lost, entering cached mode');
    set({ authMode: 'cached', isAuthenticated: false });
  },

  tryReauthenticate: async () => {
    try {
      const state = await invoke<AuthState>('auth_refresh');
      if (state.isAuthenticated) {
        set({
          user: state.user,
          profile: state.profile,
          isAuthenticated: true,
          emailConfirmed: state.emailConfirmed,
          authMode: 'authenticated',
          teamId: state.profile?.primary_team_id ?? null,
          isTeamMember: state.profile?.is_team_member ?? false,
        });
        return true;
      }
    } catch {
      // Network still down, stay in cached mode
    }
    return false;
  },

  clearError: () => set({ error: null }),

  handleAuthStateChanged: (state: AuthState) => {
    set({
      user: state.user,
      profile: state.profile,
      isAuthenticated: state.isAuthenticated,
      emailConfirmed: state.emailConfirmed,
      authMode: state.authMode ?? (state.isAuthenticated ? 'authenticated' : null),
      mfaStatus: state.mfaStatus ?? null,
      mfaFactorId: state.mfaFactorId ?? null,
      teamId: state.profile?.primary_team_id ?? null,
      isTeamMember: state.profile?.is_team_member ?? false,
      error: state.signOutReason ?? null,
    });
  },
}));
