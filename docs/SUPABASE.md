# Supabase Integration

Supabase is used for **authentication** and **tier-based feature licensing**. Storage, Realtime, and Edge Functions are not used.

## Architecture

All Supabase API calls happen in the **Electron main process**. The renderer communicates via IPC only — it never imports or calls `@supabase/supabase-js` directly.

```
Renderer (React)                    Main Process (Node.js)
─────────────────                   ──────────────────────
authStore.ts ──IPC──►  auth.ts (IPC handlers)
                           │
                           ▼
                     supabase.ts (AuthService)
                           │
                           ▼
                     Supabase Cloud
                     (Auth API + DB)
```

## Key Files

| File | Role |
|------|------|
| `electron/services/auth/supabase.ts` | Core auth service — client init, sign up/in/out, session persistence, profile fetch |
| `electron/ipc/auth.ts` | IPC handler registration (8 channels) |
| `electron/services/state.ts` | AppState singleton that owns the `AuthService` instance |
| `electron/main.ts` | Deep link protocol registration + URL parsing (lines 31-84) |
| `src/stores/authStore.ts` | Zustand store — frontend auth state + methods |
| `src/types/auth.ts` | `AuthUser`, `UserProfile`, `AuthState` interfaces |
| `src/lib/tier.ts` | `canAccessFeature()` and `getFeatureLimit()` helpers |
| `src/components/auth/AuthScreen.tsx` | Auth gate UI (login/register toggle + email confirmation modal) |
| `src/components/auth/LoginForm.tsx` | Email/password login form |
| `src/components/auth/RegisterForm.tsx` | Registration form (display name, email, password, confirm) |
| `src/components/settings/SettingsDialog.tsx` | Account tab — shows email, display name, tier, sign out |
| `src/components/layout/Sidebar.tsx` | User email in footer, sign out button |

## Database Schema

Two tables are queried (read-only from the app):

### `user_profiles`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key, matches `auth.users.id` |
| `display_name` | text | Nullable |
| `tier_id` | UUID | FK to `tiers.id`, nullable |
| `is_team_member` | boolean | Team membership flag (UI/team vault logic only) |
| `has_used_trial` | boolean | `true` once any trial starts — never reverted. Prevents re-trials. |
| `trial_ends_at` | timestamptz | Stripe trial end timestamp for UI countdown. Cleared on conversion/cancel. |
| `subscription_status` | text | `none`, `active`, `trialing`, `past_due`, `canceled` |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

### `tiers`
| Column | Type | Notes |
|--------|------|-------|
| `name` | text | Internal identifier (`free`, `pro`, `team`) |
| `display_name` | text | Shown in UI |
| `features` | jsonb | Feature flags/limits — see below |

#### Current `features` shape (post WS1/WS2a)

| Flag | Type | Free | Pro | Team |
|------|------|------|-----|------|
| `max_connections` | number | -1 | -1 | -1 |
| `cli_agents_enabled` | bool | true | true | true |
| `mcp_enabled` | bool | true | true | true |
| `mcp_daily_quota` | number | 50 | -1 | -1 |
| `chat_cloud_sync_enabled` | bool | false | true | true |
| `cloud_backup_days` | number | 1 | 14 | 180 |
| `shared_vaults` | bool | false | false | true |
| `password_history_limit` | number | 3 | -1 | -1 |

Notes:
- `-1` = unlimited for numeric limits
- `mcp_daily_quota` is enforced locally by the MCP server (honor-system)
- Removed in WS1: `ai_chat_enabled`, `ai_token_budget_monthly`, `ai_max_output`, `auto_compaction` (built-in agent retired)

### Query Pattern
Profile is fetched with a foreign-key join:
```typescript
supabase.from('user_profiles')
  .select(`
    id, display_name, tier_id, is_team_member, created_at, updated_at,
    subscription_status, trial_ends_at, has_used_trial,
    tier:tiers ( name, display_name, features )
  `)
  .eq('id', user.id)
  .single();
```

Supabase may return the joined `tier` as an array or object — the code handles both:
```typescript
const tierData = Array.isArray(data.tier) ? data.tier[0] : data.tier;
```

## Authentication Flows

### Registration
1. User fills `RegisterForm` (display name, email, password)
2. Store calls IPC `auth_sign_up` → `AuthService.signUp()`
3. Supabase creates user, sends confirmation email with redirect to `conduit://auth/callback`
4. UI shows "Check your email" modal (`AuthScreen`)
5. User clicks email link → OS opens app via deep link
6. `main.ts` parses URL fragment for `access_token` + `refresh_token`
7. `AuthService.handleDeepLinkTokens()` restores session
8. `onAuthStateChange` fires → persists session, notifies renderer
9. App unlocks (auth gate passes)

### Login
1. User fills `LoginForm` (email, password)
2. Store calls IPC `auth_sign_in` → `AuthService.signIn()`
3. If email not confirmed → returns `emailConfirmed: false`, UI shows confirmation prompt
4. If confirmed → persists session, fetches profile with tier, returns full `AuthState`
5. Store updates → auth gate passes

### App Startup (Session Restore)
1. `App.tsx` calls `useAuthStore.initialize()` on mount
2. IPC `auth_initialize` → `AuthService.initialize()`
3. Loads encrypted session file from disk
4. Calls `supabase.auth.setSession()` with stored tokens (10s timeout)
5. On success → builds full auth state with profile
6. On network error + token not expired → uses cached state (offline access)
7. On expired token → clears session, user must re-login

### Sign Out
1. `AuthService.signOut()` → `supabase.auth.signOut()`
2. Deletes persisted session file
3. Clears in-memory state
4. Notifies renderer via IPC `auth:state-changed`

## Session Persistence

**File location:** `{userData}/conduit/conduit-auth-session.enc`
- macOS: `~/Library/Application Support/conduit/conduit/conduit-auth-session.enc`
- Windows: `%APPDATA%/conduit/conduit/conduit-auth-session.enc`

**Encryption:** Uses Electron's `safeStorage.encryptString()`. Falls back to plain JSON if encryption is unavailable.

**Stored data:**
```json
{
  "access_token": "...",
  "refresh_token": "...",
  "user": { "id": "...", "email": "...", "email_confirmed_at": "...", "created_at": "..." }
}
```

Only confirmed sessions are persisted (checked via `email_confirmed_at`).

## Tier System

Feature access is checked via two functions in `src/lib/tier.ts`:

```typescript
canAccessFeature(profile, 'mcp_enabled')    // → boolean
getFeatureLimit(profile, 'max_connections')  // → number (-1 = unlimited)
```

**Resolution order:**
1. No profile → `false` / `0`
2. Check `profile.tier.features[featureName]` — truthy = enabled, number = limit

Note: `is_team_member` is used only for team-specific UI (vault sections, onboarding routing), not for feature gating.

Tier data is managed server-side only (no upgrade/downgrade UI in the app).

## IPC Channels

| Channel | Handler | Returns |
|---------|---------|---------|
| `auth_initialize` | `AuthService.initialize()` | `AuthState` |
| `auth_sign_up` | `AuthService.signUp(email, password, displayName?)` | `AuthState` |
| `auth_sign_in` | `AuthService.signIn(email, password)` | `AuthState` |
| `auth_sign_out` | `AuthService.signOut()` | `void` |
| `auth_get_state` | `AuthService.getAuthState()` | `AuthState` |
| `auth_get_profile` | `AuthService.getUserProfile()` | `UserProfile \| null` |
| `auth_refresh` | `AuthService.refreshSession()` | `AuthState` |
| `auth_resend_confirmation` | `AuthService.resendConfirmation(email)` | `void` |

The main process also pushes `auth:state-changed` events to the renderer via `BrowserWindow.webContents.send()`.

## Deep Link Protocol

**Registered protocol:** `conduit://`

**Flow:**
1. Email confirmation link redirects to `conduit://auth/callback#access_token=...&refresh_token=...`
2. OS opens the app (or focuses it if already running)
3. `main.ts:handleDeepLink()` extracts hash fragment
4. Parses `access_token` and `refresh_token` from URL params
5. Calls `AuthService.handleDeepLinkTokens()` to restore session

**Dev mode:** Registers with `process.execPath` + script path for Electron dev server.
**Single instance:** Uses `app.requestSingleInstanceLock()` — second instances forward the URL to the first.

## Configuration

**Supabase credentials** are hardcoded in `electron/services/auth/supabase.ts`:
- URL: `https://khuyzxadaszwxirwykms.supabase.co`
- Key: Anon key (public, safe to embed — RLS enforces security)

**Supabase client options:**
- `persistSession: false` — app handles its own encrypted persistence
- `autoRefreshToken: true` — SDK refreshes tokens automatically
- `detectSessionInUrl: false` — deep links are handled manually

**MCP server** (`.mcp.json`) also references the same Supabase project for AI agent access.

## Team & Shared Vault Tables

### `teams`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `name` | text | Team display name |
| `slug` | text | Unique URL-friendly identifier |
| `owner_id` | UUID | FK to `auth.users.id` |
| `stripe_subscription_id` | text | Nullable |
| `stripe_customer_id` | text | Nullable |
| `max_seats` | integer | Default 5 |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `team_members`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `team_id` | UUID | FK to `teams.id` (cascade delete) |
| `user_id` | UUID | FK to `auth.users.id` (cascade delete) |
| `role` | text | `'admin'` or `'member'` |
| `joined_at` | timestamptz | |

Unique constraint on `(team_id, user_id)`. A trigger (`sync_is_team_member`) auto-updates `user_profiles.is_team_member` and `tier_id` on insert/delete (joining a team assigns the Team tier; leaving reverts to Free if user was on the Team tier).

### `team_invitations`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `team_id` | UUID | FK to `teams.id` (cascade delete) |
| `email` | text | Invited user's email |
| `invited_by` | UUID | FK to `auth.users.id` |
| `role` | text | `'admin'` or `'member'` |
| `status` | text | `'pending'`, `'accepted'`, `'declined'`, or `'expired'` |
| `token` | text | Unique invitation token |
| `expires_at` | timestamptz | Default 7 days from creation |
| `created_at` | timestamptz | |
| `responded_at` | timestamptz | Nullable |

### `user_public_keys`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `user_id` | UUID | FK to `auth.users.id` (cascade delete) |
| `device_id` | text | Stable device identifier |
| `device_name` | text | Nullable, human-readable |
| `public_key_b64` | text | X25519 public key (base64) |
| `key_type` | text | Default `'x25519'` |
| `is_active` | boolean | Default true |
| `created_at` | timestamptz | |

Unique constraint on `(user_id, device_id)`.

### `user_key_backups`
| Column | Type | Notes |
|--------|------|-------|
| `user_id` | UUID | Primary key, FK to `auth.users.id` (cascade delete) |
| `encrypted_private_key_b64` | text | Recovery-passphrase-encrypted private key |
| `kdf_salt_b64` | text | PBKDF2 salt |
| `kdf_algorithm` | text | Default `'pbkdf2-sha256-600k'` |
| `created_at` | timestamptz | |

### `device_auth_requests`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `user_id` | UUID | FK to `auth.users.id` |
| `requesting_device_id` | text | |
| `requesting_device_name` | text | |
| `requesting_public_key_b64` | text | Temporary X25519 public key |
| `status` | text | `'pending'`, `'approved'`, `'denied'`, or `'expired'` |
| `encrypted_private_key_b64` | text | Nullable — set on approval |
| `ephemeral_public_key_b64` | text | Nullable — set on approval |
| `created_at` | timestamptz | |
| `expires_at` | timestamptz | Default 15 minutes |

### `user_profiles` (updated)
| Column | Type | Notes |
|--------|------|-------|
| `primary_team_id` | UUID | FK to `teams.id`, nullable — added for team association |

### `team_vaults`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `team_id` | UUID | FK to `teams.id` (cascade delete) |
| `name` | text | Vault display name |
| `description` | text | Nullable |
| `created_by` | UUID | FK to `auth.users.id` |
| `key_version` | integer | Current VEK version, default 1 |
| `rotation_pending` | boolean | True when member removed and VEK needs rotation |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `vault_key_wraps`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `team_vault_id` | UUID | FK to `team_vaults.id` (cascade delete) |
| `user_id` | UUID | FK to `auth.users.id` (cascade delete) |
| `ephemeral_public_key_b64` | text | ECIES ephemeral public key |
| `encrypted_vek_b64` | text | VEK encrypted with wrapping key |
| `key_version` | integer | Must match `team_vaults.key_version` |
| `created_at` | timestamptz | |

Unique constraint on `(team_vault_id, user_id, key_version)`.

### `team_vault_members`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `team_vault_id` | UUID | FK to `team_vaults.id` (cascade delete) |
| `user_id` | UUID | FK to `auth.users.id` (cascade delete) |
| `role` | text | `'admin'`, `'editor'`, or `'viewer'` |
| `added_by` | UUID | FK to `auth.users.id`, nullable |
| `created_at` | timestamptz | |

Unique constraint on `(team_vault_id, user_id)`.

### `vault_entries` (cloud-synced)
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `vault_id` | UUID | References team vault ID |
| `name` | text | Entry display name |
| `entry_type` | text | `'ssh'`, `'rdp'`, `'vnc'`, `'web'`, or `'credential'` |
| `folder_id` | UUID | FK to `vault_folders.id`, nullable |
| `sort_order` | integer | Default 0 |
| `host` | text | Nullable |
| `port` | integer | Nullable |
| `username` | text | Nullable |
| `domain` | text | Nullable |
| `password_encrypted` | text | Base64, encrypted with VEK client-side |
| `private_key_encrypted` | text | Base64, encrypted with VEK client-side |
| `config_encrypted` | text | Base64, encrypted with VEK client-side |
| `tags_encrypted` | text | Base64, encrypted with VEK client-side |
| `is_favorite` | boolean | Default false |
| `version` | integer | Optimistic concurrency version, default 1 |
| `updated_by` | UUID | FK to `auth.users.id` |
| `deleted_at` | timestamptz | Soft-delete timestamp, nullable |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `vault_folders` (cloud-synced)
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `vault_id` | UUID | References team vault ID |
| `name` | text | Folder display name |
| `parent_id` | UUID | Self-referential FK, nullable |
| `sort_order` | integer | Default 0 |
| `icon` | text | Nullable |
| `color` | text | Nullable |
| `version` | integer | Default 1 |
| `updated_by` | UUID | FK to `auth.users.id` |
| `deleted_at` | timestamptz | Soft-delete, nullable |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `vault_password_history` (cloud-synced)
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `vault_id` | UUID | References team vault ID |
| `entry_id` | UUID | Entry whose password changed |
| `username` | text | Username at time of change, nullable |
| `password_encrypted` | text | VEK-encrypted old password, nullable |
| `changed_at` | timestamptz | When the change occurred |
| `changed_by` | UUID | FK to `auth.users.id`, nullable |
| `deleted_at` | timestamptz | Soft-delete, nullable |
| `created_at` | timestamptz | |

RLS: select = any vault member, insert/update = editor+admin, delete = admin only.

### `vault_folder_permissions`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `vault_id` | UUID | References team vault ID |
| `folder_id` | UUID | FK to `vault_folders.id` (cascade delete) |
| `user_id` | UUID | FK to `auth.users.id` (cascade delete) |
| `role` | text | `'admin'`, `'editor'`, or `'viewer'` |
| `granted_by` | UUID | FK to `auth.users.id`, nullable |
| `created_at` | timestamptz | |

Unique constraint on `(vault_id, folder_id, user_id)`. If no permissions exist for a vault, all members have full access (backward compatible).

### `vault_audit_log`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `team_id` | UUID | FK to `teams.id` (cascade delete) |
| `team_vault_id` | UUID | FK to `team_vaults.id` (set null on delete), nullable |
| `actor_id` | UUID | FK to `auth.users.id` |
| `actor_email` | text | Actor's email at time of action |
| `action` | text | One of: `entry_create`, `entry_update`, `entry_delete`, `entry_view`, `password_changed`, `password_history_delete`, `folder_create`, `folder_update`, `folder_delete`, `member_add`, `member_remove`, `member_role_change`, `vault_create`, `vault_delete`, `vault_access`, `permission_grant`, `permission_revoke`, `invitation_sent`, `invitation_accepted`, `invitation_declined` |
| `target_type` | text | Nullable |
| `target_id` | text | Nullable |
| `target_name` | text | Nullable |
| `details` | jsonb | Default `{}` |
| `created_at` | timestamptz | |

RLS: Readable only by team admins. Insertable by any team member (actor_id must match auth.uid()).

**Retention Policy:** Audit logs older than 2 years are automatically purged daily at 3:00 AM UTC via `pg_cron`. The `purge_old_audit_logs()` function runs as a scheduled job and returns the count of deleted rows. See `supabase/migrations/20260226_audit_log_retention.sql`.

### `vault_locks`
| Column | Type | Notes |
|--------|------|-------|
| `vault_id` | UUID | Primary key |
| `locked_by` | UUID | FK to `auth.users.id` |
| `locked_at` | timestamptz | |
| `expires_at` | timestamptz | Lock TTL (60s), extended by heartbeat |
| `device_id` | text | Nullable |
| `user_email` | text | Nullable, for display in lock dialog |

Pro plan users acquire exclusive locks (60s TTL, 30s heartbeat). Team plan users skip locking entirely. Expired locks can be deleted by anyone. Added to `supabase_realtime` publication for live status updates.

### RPC Functions

| Function | Purpose |
|----------|---------|
| `upsert_vault_entry_versioned(...)` | Atomic version-checked insert/update for optimistic concurrency |
| `user_can_access_folder(vault_id, folder_id, user_id)` | Recursive folder permission check (returns role or NULL) |
| `purge_old_audit_logs()` | Scheduled (pg_cron): deletes audit log entries older than 2 years |

## Important Implementation Details

- **Deadlock prevention:** The `onAuthStateChange` callback must NOT call back into the Supabase client (e.g. `getUser()`). Supabase awaits all callbacks before `setSession()` returns, causing a deadlock. Profile is fetched in a background `.then()` instead.
- **Offline support:** If network is unavailable but the JWT isn't expired, the app uses cached auth state. Users can access the app offline until their token expires.
- **Supabase join variance:** The `tier` field from a foreign-key join may come back as an array or an object depending on the Supabase SDK version — always handle both.
- **No embedded joins from `team_members` to `user_profiles`:** PostgREST cannot resolve the indirect FK path `team_members.user_id` → `auth.users(id)` ← `user_profiles.id`. Queries like `.select('user_id, user:user_profiles(email)')` will **silently fail** (return null data with an error that's easy to miss). Always use two separate queries: first fetch `team_members`, then fetch `user_profiles` by ID, then merge client-side via a Map.
- **`user_profiles` has no `email` column:** Email lives on `auth.users` only. To get member emails, use `supabase.auth.admin.getUserById(userId)` (requires service role client). Never select `email` from `user_profiles` — it doesn't exist and will cause the query to fail silently.
