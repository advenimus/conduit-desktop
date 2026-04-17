export interface UserProfile {
  id: string;
  display_name: string | null;
  tier_id: string | null;
  is_team_member: boolean;
  primary_team_id: string | null;
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

export interface AuthUser {
  id: string;
  email: string;
  email_confirmed_at: string | null;
  created_at: string;
}

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
