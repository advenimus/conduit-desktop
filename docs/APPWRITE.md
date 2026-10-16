# Appwrite Backend

Conduit's backend is a self-hosted Appwrite. It is used for **authentication**, **tier-based feature
licensing**, **personal vault device leases and ownership**, **team vaults**, **cloud backups** and
**feedback**. It never holds personal vault content.

It replaced Supabase in October 2026. The old Postgres rules (RLS policies, triggers, SQL functions,
storage policies and pg_cron jobs) were ported to TypeScript, so the apps send the same requests and
get the same answers. The SQL files in `supabase/migrations/` are history now; the Supabase project is
retired after the cutover.

Related docs:

- `docs/appwrite-migration/API_CONTRACT.md`: the request and response format every client uses.
- `docs/appwrite-migration/PHASE_0_SPIKE.md`: what was tested before the move, and why the design looks this way.
- `docs/LOCAL_APPWRITE.md`: the local stack for development.

## Architecture

```
Renderer (React)          Main Process (Node.js)                      Appwrite
────────────────          ──────────────────────                      ────────
authStore.ts ──IPC──►  auth.ts (IPC handlers)
                           │
                           ▼
                     auth-service.ts (AuthService) ──── Account API ──► Auth (sessions, MFA)
                           │
                           ▼
                     ConduitDb (getDb()) ─── function execution ──► `api` function ──► TablesDB `conduit`
                                                                         │               Storage buckets
                     realtime.ts ◄──────── Realtime socket ──────────────┴─── row events
```

All backend calls happen in the **Electron main process**. The renderer talks to it over IPC only.

### The `api` function

There is one Appwrite Function, `api` (Node 22). Its source is `appwrite/src/api/`; the runtime entry
is `appwrite/src/runtime/main.ts`. It has three triggers:

| Trigger | What it does |
|---|---|
| HTTP execution | Takes a PostgREST-style request (`kind: query`, `rpc` or `storage`) and answers `{data, count, error}` with Postgres error codes |
| Events `users.*.create`, `users.*.delete` | A new account gets its Free `user_profiles` row (the old `handle_new_user`). A deleted account replays the old `ON DELETE` rules for every table that pointed at `auth.users` |
| Schedule `0 3 * * *` (daily, 03:00 UTC) | The nightly job (below) |

The function knows three kinds of caller:

- **authenticated**: a signed-in user. Appwrite passes the user ID in `x-appwrite-user-id`.
- **service**: server code with an API key that also sends `x-conduit-service: <CONDUIT_SERVICE_SECRET>`.
  Row rules are skipped; triggers still run. Used by the website, the verify harness and scripts.
- **anon**: anything else. Anonymous callers cannot execute the function at all (`execute: ['users']`).

Where the old rules live now:

| Was (Postgres) | Now (`appwrite/src/api/`) |
|---|---|
| RLS policies | `policies.ts` (a missing policy means "deny", as in Postgres) |
| Triggers (column guards, seat limits, membership sync, cleanup) | `triggers.ts` |
| Session RPCs and owner rules | `rpc/sessions.ts` |
| `upsert_vault_entry_versioned`, `get_team_members_with_email` | `rpc/team.ts` |
| Minimum app version helpers (`app_version_ok` and friends) | `rpc/versions.ts` |
| `storage.objects` policies | `storage.ts` |
| conduit-backend `POST /api/fingerprint` | `rpc/fingerprint.ts` (`submit_fingerprint` RPC) |
| `feedback-email-notify` edge function, `sync_email_to_resend` | `appwrite/src/runtime/effects.ts` |
| pg_cron jobs | `jobs.ts` and `runtime/main.ts` |

`conduit-backend` (Vercel) is retired. The device fingerprint and abuse check is now the
`submit_fingerprint` RPC, which the app calls in the background after each sign-in.

### Guard revisions (concurrency)

Appwrite transactions do not serialize reads, so a plain "read, check, write" can be raced: in the
spike, 12 of 20 parallel lease requests won against a limit of 1. Every rule that depends on a count or
on another row uses a **guard revision** instead:

1. Each scope (an account, a vault, a team, a user's files in a bucket, a unique key) has rows in the
   internal `guards` table.
2. A write first reads the scope's latest `rev` (`uow.guard(scope)` in `uow.ts`), then reads the state
   the rule needs and checks the rule.
3. It commits one transaction with the real change plus a guard row with a fixed ID, `hash(scope, rev + 1)`.
4. A parallel writer of the same scope tries to create the same guard row, gets a 409, and retries from
   fresh reads (up to 8 times, then error `40001`).

Every writer of a guarded scope must take the guard, or the rule can be broken. Scopes in use include
`vault-acct:<uid>` and `vault-owner:<vault_key>` (leases and ownership), `team:<team_id>` (seats),
`vault:<vault_id>` (versioned entry writes), `files:<bucket>:<uid>` (backup caps) and `uq:...` (unique
columns Appwrite cannot index). The nightly job deletes guard rows older than a day that are not the
latest of their scope.

### Realtime and vault teams

Clients subscribe with the Appwrite Realtime client and their own session. Rows reach only users with
read permission on them, so the function writes a read permission on every row of a Realtime table:

| Tables | Read permission | Who receives updates |
|---|---|---|
| `vault_entries`, `vault_folders`, `vault_password_history`, `vault_folder_permissions`, `vault_locks` | `team:<vault_id>` | Members of that team vault |
| `personal_vault_sessions` | `user:<user_id>` | The lease owner |

Each team vault has an Appwrite team with the same ID as the vault (`team:<vault_id>`). When a
`team_vault_members` row changes, the function adds, updates or removes that user's membership
(`syncVaultTeam` in `appwrite/src/runtime/services.ts`). These teams are only for Realtime permissions;
the app's own teams live in the `teams` table.

The desktop subscribes in `electron/services/backend/realtime.ts`. Payloads are **raw Appwrite rows**:
the key of a single-key table arrives as `$id`, and JSON columns arrive as strings. The code decodes
them before use. Channels and queries are in the API contract.

### Storage via `cloud_files`

Buckets `vaults` (cloud backups) and `feedback-logs` (feedback attachments) hold the bytes under random
Appwrite file IDs. The table `cloud_files` maps each old Supabase path (`<uid>/<vault>/vault.enc`) to its
file ID, owner, size and type, and backs `list`. Clients keep using paths. The path rules are the old
ones: users touch only `<their uid>/...`; `vaults` writes need cloud backup on the plan, an allowed file
name and a free slot; `feedback-logs` is upload-only for users. The largest file through the function is
7 MB. When a `cloud_files` row is removed or replaced, its bytes are deleted after the commit.

### User events

- `users.*.create`: inserts the `user_profiles` row (Free tier, display name from prefs, name or email),
  then adds the email to the Resend segment when `RESEND_CONTACTS_API_KEY` and `RESEND_SEGMENT_ID` are set.
- `users.*.delete`: deletes or nulls the user's rows the way the old foreign keys did, and frees their files.

New user IDs must be lowercase UUIDs, because every table keys users by UUID. Clients pass their own ID
when creating an account. Imported Supabase users kept their old UUIDs.

### Nightly job

Runs daily at 03:00 UTC:

- Deletes `vault_audit_log` rows older than 2 years (was `purge_old_audit_logs()`).
- Deletes `personal_vault_sessions` rows whose last heartbeat is older than 30 days (was
  `purge-personal-vault-sessions`).
- Prunes old guard revisions.
- Deletes bucket files with no `cloud_files` row that are older than an hour (an upload that lost a
  race or crashed between its two steps).

## Key Files

| File | Role |
|------|------|
| `appwrite/src/api/` | The `api` function: request handling, rules, triggers, RPCs, storage |
| `appwrite/src/runtime/main.ts` | Function entry: callers, events, schedule |
| `appwrite/src/schema/tables.ts` | Schema as code: tables, columns, indexes, foreign keys, Realtime, buckets |
| `appwrite/src/schema/seed.ts` | Plan tiers and `app_config` rows for new stacks |
| `appwrite/src/client/index.ts` | `ConduitDb`, a client with the supabase-js call shape (`from().select().eq()`, `rpc()`, `storage.from()`) |
| `appwrite/scripts/deploy.ts` | Applies schema, buckets and the function to a project |
| `appwrite/scripts/import-supabase.ts` | One-time copy of the Supabase project into Appwrite (cutover) |
| `electron/services/auth/auth-service.ts` | Desktop auth: session handoff, persistence, profile fetch, JWT, `getDb()` |
| `electron/services/backend/conduit-db.ts` | Copy of `appwrite/src/client/index.ts` for the main process |
| `electron/services/backend/transport.ts` | Sends `ConduitDb` requests as function executions |
| `electron/services/backend/realtime.ts` | Appwrite Realtime in Node, raw rows decoded |
| `electron/services/env-config.ts` | Endpoint, project and website URL per environment |
| `electron/services/vault-session/session-client.ts` | Typed, validated wrappers of the session RPCs |
| `electron/services/vault-session/host-electron-appwrite.ts` | RPC caller with a hard timeout, and the own-row Realtime subscription on `personal_vault_sessions` |
| `electron/ipc/auth.ts` | Auth IPC handlers |
| `electron/main.ts` | `conduit://` protocol registration and deep link parsing |
| `src/stores/authStore.ts` | Zustand store, frontend auth state |
| `src/lib/tier.ts` | `canAccessFeature()` and `getFeatureLimit()` |

`electron/services/backend/conduit-db.ts` must stay a copy of `appwrite/src/client/index.ts`. Change both together.

## Environments

| | Endpoint | Project ID | Website |
|---|---|---|---|
| Preview (dev) | `http://localhost:8085/v1` | `conduit-dev` | `http://localhost:3000` |
| Production | `https://appwrite.cloudwise.ca/v1` | `6acf9d610020fad67ba9` | `https://conduitdesktop.com` |

`CONDUIT_ENV` picks the environment (`electron/services/env-config.ts`). Unpackaged preview builds also
read `CONDUIT_DEV_APPWRITE_ENDPOINT` (loopback URLs only; the verify harness uses it for its offline
proxy) and `CONDUIT_DEV_APPWRITE_PROJECT`. Packaged builds ignore both. The endpoint and project ID are
public; only the API key and the service secret are secret.

## Authentication

### Sign-in and sign-up

The website signs the user in. The app never sees a password.

1. The app opens the website's sign-in or sign-up page (`auth_open_login`, `auth_open_signup`).
2. The website runs the password step and the MFA step, then hands the verified Appwrite session to the
   app: `conduit://auth/callback#user_id=<id>&session=<secret>`. The website forgets that session.
3. `main.ts` parses the link and calls `AuthService.handleDeepLinkSession(userId, secret)`.
4. The service checks the session belongs to that user, reads its expiry, and adopts it.
5. In production an account without MFA (`user.mfa` false) is signed out with "Two-factor
   authentication is now required". A local stack skips this rule.
6. The profile with its tier is fetched, the session is saved, and the fingerprint check runs in the background.

A session the website created with a one-time token would ask for MFA again, which is why the website
hands over the session it already verified (see the Phase 0 notes).

### App startup (session restore)

1. `App.tsx` calls `useAuthStore.initialize()`; IPC `auth_initialize` runs `AuthService.initialize()`.
2. It loads the encrypted session file and calls `account.get()` (10 s timeout).
3. On success it builds the full auth state with the profile.
4. Offline, or on a network error: it uses the cached state while the session has not expired, or while
   a cached tier is still valid.
5. A 401 or 403 deletes the saved session; the user signs in again.
6. `user_more_factors_required` shows the MFA prompt.

### Sign out

`AuthService.signOut()` deletes the current Appwrite session (failures are logged and ignored), deletes
the session file, clears the state and notifies the renderer (`auth:state-changed`).

### Calls to the website API

Calls to the website's API carry a short-lived Appwrite JWT (`getAccessToken()`, reused for 10 minutes).
The website checks it server-side.

### Session persistence

**File:** `{dataDir}/conduit-auth-session.enc`, for example
`~/Library/Application Support/conduit/conduit/conduit-auth-session.enc` in production.

**Encryption:** Electron's `safeStorage`.

**Stored data:** `session_secret`, `expire` (ISO time or null) and `user` (`id`, `email`,
`email_confirmed_at`, `created_at`).

## Data access

Code in the main process calls `authService.getDb()`, a `ConduitDb` with the supabase-js call shape:

```typescript
const { data, error } = await authService.getDb()
  .from('user_profiles')
  .select(`
    id, display_name, tier_id, is_team_member, created_at, updated_at,
    subscription_status, trial_ends_at, has_used_trial,
    tier:tiers ( name, display_name, features )
  `)
  .eq('id', user.id)
  .single();
```

Each call becomes one synchronous execution of the `api` function as the signed-in user. Signed out,
every call answers `28000` (not signed in). Supported filters, embeds, RPCs and storage actions are
listed in the API contract.

## Tier System

Feature access is checked with two functions in `src/lib/tier.ts`:

```typescript
canAccessFeature(profile, 'mcp_enabled')    // → boolean
getFeatureLimit(profile, 'max_connections')  // → number (-1 = unlimited)
```

**Resolution order:**
1. No profile → `false` / `0`
2. Check `profile.tier.features[featureName]`: truthy = enabled, number = limit

`is_team_member` is used only for team-specific UI (vault sections, onboarding routing), not for
feature gating. Tier data is managed server-side only (no upgrade or downgrade UI in the app).

## Tables

The schema is `appwrite/src/schema/tables.ts`, ported from the production Postgres schema on
2026-10-14. Column names, defaults, allowed values and foreign keys match Postgres. A table with a
single key column stores it as the row's `$id`. "User" below means the Appwrite user (was `auth.users`).

| Table | Key | Purpose |
|---|---|---|
| `tiers` | `id` | Plans and their `features` |
| `app_config` | `key` | Server settings, no client access |
| `user_profiles` | `id` | One row per user: plan, billing, trial, abuse fields |
| `teams`, `team_members`, `team_invitations` | `id` | Teams, seats and invitations |
| `team_vaults`, `team_vault_members`, `vault_key_wraps` | `id` | Shared vaults, their members and wrapped keys |
| `vault_entries`, `vault_folders`, `vault_password_history`, `vault_folder_permissions` | `id` | Team vault content (encrypted client-side) and folder grants |
| `vault_audit_log` | `id` | Team vault audit trail |
| `vault_locks` | `vault_id` | Pro exclusive locks on team vaults |
| `user_public_keys`, `user_key_backups`, `device_auth_requests` | `id` / `user_id` | Device keys, key backup, device approval |
| `feedback_submissions` | `id` | Bug reports and feedback (emailed through Resend) |
| `personal_vault_sessions` | `user_id, vault_key, device_id` | Personal vault device leases |
| `personal_vault_owners` | `vault_key` | Who owns a personal vault, grace and release |
| `personal_vault_guest_grace` | `account_lo, account_hi` | Grace start per pair of accounts |
| `device_fingerprints`, `abuse_flags` | `id` | Fingerprint and abuse check |
| `cloud_files` | `bucket, path` | Path to file ID map for the storage buckets |
| `guards` | internal | Guard revisions; never exposed to clients |

### `user_profiles`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key, matches the Appwrite user ID |
| `display_name` | text | Nullable |
| `tier_id` | UUID | Points to `tiers.id`, nullable |
| `is_team_member` | boolean | Team membership flag (UI and team vault logic only) |
| `primary_team_id` | UUID | Points to `teams.id`, nullable |
| `has_used_trial` | boolean | `true` once any trial starts, never reverted. Prevents re-trials |
| `trial_ends_at` | datetime | Stripe trial end for the UI countdown. Cleared on conversion or cancel |
| `subscription_status` | text | `none`, `active`, `trialing`, `past_due`, `canceled` |
| `created_at`, `updated_at` | datetime | |

**Column guard.** Users may update their own row, but `triggers.ts` rejects any user change to plan,
billing, trial and abuse columns with `42501 protected column`. Users may still change `display_name`
and `primary_team_id`, and may set `stripe_customer_id` only while it is null. Service calls (Stripe
webhook, team routes) are unaffected. `teams` has the same guard for its owner, seat and billing columns.

`user_profiles` has no `email` column. Email lives on the Appwrite user. For member emails use the
`get_team_members_with_email` RPC.

### `tiers`
| Column | Type | Notes |
|--------|------|-------|
| `name` | text | Internal identifier (`free`, `pro`, `team`) |
| `display_name` | text | Shown in UI |
| `features` | json | Feature flags and limits, see below |

#### Current `features` shape (production, 2026-10-14)

| Flag | Type | Free | Pro | Team |
|------|------|------|-----|------|
| `max_connections` | number | -1 | -1 | -1 |
| `cli_agents_enabled` | bool | true | true | true |
| `mcp_enabled` | bool | true | true | true |
| `mcp_daily_quota` | number | -1 | -1 | -1 |
| `cloud_sync_enabled` | bool | false | true | true |
| `vault_max_open_devices` | number | 1 | -1 | -1 |
| `personal_sync` | text | `on` | `on` | `on` |
| `backup_retention_days` | number | 1 | 14 | 180 |
| `max_cloud_backups` | number | 3 | 25 | -1 |
| `max_cloud_backup_vaults` | number | 0 | 10 | -1 |
| `account_max_active_devices` | number | 5 | 5 | 5 |
| `shared_vaults` | bool | false | false | true |
| `chat_cloud_sync_enabled` | bool | false | true | true |
| `beta_features_enabled` | bool | false | false | true |
| `is_per_seat` | bool | - | - | true |

`password_history_limit` is not set on any live tier; `src/lib/tier.ts` falls back to 3 for Free and
unlimited for Pro and Team. The same values are in `appwrite/src/schema/seed.ts` for new stacks.

Notes:
- `-1` = unlimited for numeric limits
- `mcp_daily_quota` is retired. It stays `-1` on every tier because MCP builds before the removal cap at 50/day when the key is missing
- `cloud_sync_enabled` means whole-file **cloud backup**. The name is kept for older clients; it does not gate multi-device sync
- `vault_max_open_devices`: how many devices may have one personal vault open (unlocked) at once. Free is `1`. Setting Free to `-1` turns enforcement off without a client release. Team members always get `-1` server-side (`is_team_member`)
- `account_max_active_devices` (plan enforcement, `docs/PLAN_ENFORCEMENT.md` 2.4): devices with any personal vault open at once, per account. `-1` means no cap; a missing key uses `app_config.account_max_active_devices_fallback` (5). Team vaults do not count. The desktop reads it for display only
- `max_cloud_backups` counts snapshots per vault folder; `max_cloud_backup_vaults` counts vault folders per account (plan enforcement 2.9). `storage.ts` enforces the plan, the file names and both caps on every `vaults` upload
- `personal_sync`: `on` or `paused`. Kill switch for the personal sync engine; `paused` stops merging and publishing, and every edit stays in the device's working copy
- The merge engine itself is not gated by plan. See `docs/MULTI_DEVICE_SYNC.md` section 8
- `chat_cloud_sync_enabled` is no longer read by the app (the in-app chat history layer was removed)

### `app_config` (server settings, no client access)

A key/value table read only by the function (`docs/PLAN_ENFORCEMENT.md` 2.2). Changing a row needs no
client release.

| Key | Default | Meaning |
|-----|---------|---------|
| `min_app_version` | `{"desktop": "0.0.0", "ios": "0.0.0"}` | Minimum app version per platform group. `0.0.0` turns the check off. Below it, the lease RPCs answer `update_required` and the app shows "Update required" |
| `vault_share_grace_days` | `14` | How long another account may use a vault (per vault and per pair of accounts) |
| `vault_release_cooldown_days` | `7` | How long after becoming owner an account can release a vault (`0` turns it off) |
| `account_max_active_devices_fallback` | `5` | Device cap when the tier has no `account_max_active_devices` |

To change a value, edit the row in the console (database `conduit`, table `app_config`, column `value`
holds JSON text), or update it through the function as the service:
`db.from('app_config').update({ value: { desktop: '0.19.0', ios: '0.0.0' } }).eq('key', 'min_app_version')`.

### Team and shared vault tables

#### `teams`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key |
| `name` | text | Team display name |
| `slug` | text | Unique URL-friendly identifier |
| `owner_id` | UUID | The owning user |
| `stripe_subscription_id`, `stripe_customer_id` | text | Nullable |
| `max_seats` | integer | Default 5 |
| `created_at`, `updated_at` | datetime | |

#### `team_members`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key |
| `team_id` | UUID | Points to `teams.id` (cascade delete) |
| `user_id` | UUID | The member (cascade delete) |
| `role` | text | `admin` or `member` |
| `joined_at` | datetime | |

Unique on `(team_id, user_id)`. A trigger keeps `user_profiles.is_team_member` and `tier_id` in step on
insert and delete (joining assigns the Team tier; leaving reverts to Free if the user was on Team). The
seat limit is checked under the `team:<team_id>` guard; a team without a `stripe_subscription_id`
refuses new members. Removing a member drops their vault rights in that team and flags key rotation.

#### `team_invitations`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key |
| `team_id` | UUID | Points to `teams.id` (cascade delete) |
| `email` | text | Invited user's email |
| `invited_by` | UUID | The inviting user |
| `role` | text | `admin` or `member` |
| `status` | text | `pending`, `accepted`, `declined` or `expired` |
| `token` | text | Unique invitation token |
| `expires_at` | datetime | Default 7 days from creation |
| `created_at`, `responded_at` | datetime | `responded_at` nullable |

Team admins read and edit their team's invitations. The invitee (matched on the account email) reads
theirs and may only move a pending invitation to `accepted` or `declined`, so they cannot raise the
`role` the website's accept route then grants.

#### `user_public_keys`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key |
| `user_id` | UUID | Cascade delete |
| `device_id` | text | Stable device identifier |
| `device_name` | text | Nullable |
| `public_key_b64` | text | X25519 public key (base64) |
| `key_type` | text | Default `x25519` |
| `is_active` | boolean | Default true |
| `created_at` | datetime | |

Unique on `(user_id, device_id)`.

#### `user_key_backups`
| Column | Type | Notes |
|--------|------|-------|
| `user_id` | UUID | Key, cascade delete |
| `encrypted_private_key_b64` | text | Recovery-passphrase-encrypted private key |
| `kdf_salt_b64` | text | PBKDF2 salt |
| `kdf_algorithm` | text | Default `pbkdf2-sha256-600k` |
| `created_at` | datetime | |

#### `device_auth_requests`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key |
| `user_id` | UUID | |
| `requesting_device_id`, `requesting_device_name` | text | |
| `requesting_public_key_b64` | text | Temporary X25519 public key |
| `status` | text | `pending`, `approved`, `denied` or `expired` |
| `encrypted_private_key_b64`, `ephemeral_public_key_b64` | text | Nullable, set on approval |
| `created_at` | datetime | |
| `expires_at` | datetime | Default 15 minutes |

#### `team_vaults`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key. Also the ID of the vault's Appwrite team (Realtime) |
| `team_id` | UUID | Points to `teams.id` (cascade delete) |
| `name` | text | Vault display name |
| `description` | text | Nullable |
| `created_by` | UUID | |
| `key_version` | integer | Current VEK version, default 1 |
| `rotation_pending` | boolean | True when a member was removed and the VEK needs rotation |
| `created_at`, `updated_at` | datetime | |

#### `vault_key_wraps`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key |
| `team_vault_id` | UUID | Points to `team_vaults.id` (cascade delete) |
| `user_id` | UUID | Cascade delete |
| `ephemeral_public_key_b64` | text | ECIES ephemeral public key |
| `encrypted_vek_b64` | text | VEK encrypted with the wrapping key |
| `key_version` | integer | Must match `team_vaults.key_version` |
| `created_at` | datetime | |

Unique on `(team_vault_id, user_id, key_version)`.

#### `team_vault_members`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key |
| `team_vault_id` | UUID | Points to `team_vaults.id` (cascade delete) |
| `user_id` | UUID | Cascade delete |
| `role` | text | `admin`, `editor` or `viewer` |
| `added_by` | UUID | Nullable |
| `created_at` | datetime | |

Unique on `(team_vault_id, user_id)`. Every change syncs the user's membership in the vault's Appwrite team.

#### `vault_entries` (cloud-synced, Realtime)
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key |
| `vault_id` | UUID | Team vault ID |
| `name` | text | Entry display name |
| `entry_type` | text | `ssh`, `rdp`, `vnc`, `web`, `credential` and the other entry types |
| `folder_id` | UUID | Points to `vault_folders.id`, nullable |
| `sort_order` | integer | Default 0 |
| `host`, `port`, `username`, `domain` | text / integer | Nullable |
| `password_encrypted`, `private_key_encrypted`, `config_encrypted`, `tags_encrypted` | text | Base64, encrypted with the VEK client-side |
| `is_favorite` | boolean | Default false |
| `version` | integer | Optimistic concurrency version, default 1 |
| `updated_by` | UUID | |
| `deleted_at` | datetime | Soft delete, nullable |
| `created_at`, `updated_at` | datetime | |

Writes go through `upsert_vault_entry_versioned` (version-checked insert or update, 23 arguments).

#### `vault_folders` (cloud-synced, Realtime)
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key |
| `vault_id` | UUID | Team vault ID |
| `name` | text | Folder display name |
| `parent_id` | UUID | Parent folder, nullable |
| `sort_order` | integer | Default 0 |
| `icon`, `color` | text | Nullable |
| `version` | integer | Default 1 |
| `updated_by` | UUID | |
| `deleted_at` | datetime | Soft delete, nullable |
| `created_at`, `updated_at` | datetime | |

#### `vault_password_history` (cloud-synced, Realtime)
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key |
| `vault_id` | UUID | Team vault ID |
| `entry_id` | UUID | Entry whose password changed |
| `username` | text | Username at the time of the change, nullable |
| `password_encrypted` | text | VEK-encrypted old password, nullable |
| `changed_at` | datetime | When the change happened |
| `changed_by` | UUID | Nullable |
| `deleted_at` | datetime | Soft delete, nullable |
| `created_at` | datetime | |

Rules: select = any vault member, insert and update = editor and admin, delete = admin only.

#### `vault_folder_permissions` (Realtime)
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key |
| `vault_id` | UUID | Team vault ID |
| `folder_id` | UUID | Points to `vault_folders.id` (cascade delete) |
| `user_id` | UUID | Cascade delete |
| `role` | text | `admin`, `editor` or `viewer` |
| `granted_by` | UUID | Nullable |
| `created_at` | datetime | |

Unique on `(vault_id, folder_id, user_id)`. A folder grant (or the nearest ancestor's) can only lower
the vault role, never raise it (`folderRole()` in `policies.ts`, was `user_can_access_folder`). With no
grants in a vault, every member has their vault role everywhere.

#### `vault_audit_log`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Key |
| `team_id` | UUID | Points to `teams.id` (cascade delete) |
| `team_vault_id` | UUID | Points to `team_vaults.id` (set null on delete), nullable |
| `actor_id` | UUID | Must be the caller |
| `actor_email` | text | Actor's email at the time |
| `action` | text | One of: `entry_create`, `entry_update`, `entry_delete`, `entry_view`, `password_changed`, `password_history_delete`, `folder_create`, `folder_update`, `folder_delete`, `member_add`, `member_remove`, `member_role_change`, `vault_create`, `vault_delete`, `vault_access`, `permission_grant`, `permission_revoke`, `invitation_sent`, `invitation_accepted`, `invitation_declined` |
| `target_type`, `target_id`, `target_name` | text | Nullable |
| `details` | json | Default `{}` |
| `created_at` | datetime | |

Readable only by team admins. Any team member may insert. Rows older than 2 years are deleted by the nightly job.

#### `vault_locks` (Realtime)
| Column | Type | Notes |
|--------|------|-------|
| `vault_id` | UUID | Key |
| `locked_by` | UUID | |
| `locked_at` | datetime | |
| `expires_at` | datetime | Lock time limit (60 s), extended by heartbeat |
| `device_id` | text | Nullable |
| `user_email` | text | Nullable, shown in the lock dialog |

Pro users take exclusive locks (60 s limit, 30 s heartbeat). Team plan users skip locking. Anyone may
delete an expired lock.

### RPCs

| Function | Purpose |
|----------|---------|
| `vault_session_peek`, `_acquire`, `_heartbeat`, `_release`, `_abandon` | Personal vault leases (below) |
| `vault_owner_release` | Release a personal vault's ownership (`docs/PLAN_ENFORCEMENT.md`) |
| `upsert_vault_entry_versioned(...)` | Version-checked insert or update of a team vault entry |
| `get_team_members_with_email(p_team_id)` | Team members with email and display name |
| `submit_fingerprint` | Device fingerprint and abuse check after sign-in |

Arguments and answers are in the API contract. Answers keep the exact JSON shapes of the old SQL functions.

## Personal Vault Sessions (Device Limits)

Control plane for personal vault multi-device sync (full design: `docs/MULTI_DEVICE_SYNC.md`, sections
6 and 9; ownership and caps: `docs/PLAN_ENFORCEMENT.md`). It enforces `vault_max_open_devices`, handles
take-over, and carries each device's publish marker. It holds no vault content and no keys. Only
signed-in devices use it; signed-out devices rely on an owner claim stored inside the vault file.

Code: `appwrite/src/api/rpc/sessions.ts` (the old `20260926150829`, `20260926150905`, `20260927234038`
and plan enforcement migrations).

### `personal_vault_sessions`
One row per (user, vault, device). Key `(user_id, vault_key, device_id)`; these three are normal fields
in Realtime payloads.

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | UUID | Cascade delete |
| `vault_key` | UUID | The vault's lineage id (`sync_state.lineage_id` inside the file) |
| `device_id` | UUID | Per-install device id |
| `lease_id` | UUID | New on every acquire; heartbeat and release must match it |
| `session_nonce` | UUID | Per app launch; a second running copy with the same device id is superseded |
| `device_name` | text | 1 to 120 characters |
| `platform` | text | `macos`, `windows`, `linux`, `ios`, `ipados` |
| `app_version`, `file_name`, `file_id`, `location` | text / UUID | Shown to other devices ("open on MacBook from iCloud Drive") |
| `status` | text | `active`, `released`, `expired`, `displaced` |
| `acquired_at`, `heartbeat_at`, `expires_at`, `last_active_at` | datetime | Lease time limit is 90 s, heartbeat every 30 s |
| `busy` | json | `{sessions, jobs}` counts, at most 256 bytes. Busy devices are displaced last |
| `flags` | json | Side-file and similar flags, at most 256 bytes |
| `displaced_by_device`, `displaced_reason`, `displaced_at` | UUID / text / datetime | Reason is `takeover`, `plan_limit`, `device_cap`, `not_owner` or `update_required` |
| `written_vv`, `written_at` | json / datetime | The last publish marker of this device, at most 1024 bytes |
| `pending_changes` | boolean | The device has changes it could not publish |
| `abandoned_at` | datetime | Set by "Stop waiting for X"; cleared when that device reports a new marker |

- Users read only their own rows. Clients never write the table directly; they use the RPCs below.
- Realtime: each row has read permission for its owner. The desktop subscribes to its own rows
  (`device_id` equal to its id) to learn about a displacement in 1 to 2 s; the next heartbeat is the fallback.
- The nightly job deletes rows whose last heartbeat is older than 30 days.

### Session RPCs

| Function | Returns | Purpose |
|----------|---------|---------|
| `vault_session_peek(p_vault_key, p_device_id, p_platform, p_app_version)` | `{limit, holders}` or null | Read-only check before the password prompt (3 s timeout on the client; skipped when offline) |
| `vault_session_acquire(p_vault_key, p_device_id, p_session_nonce, p_device_name, p_platform, p_app_version, p_file_name, p_file_id, p_location, p_takeover, p_claim)` | object | Takes the lease. At the limit without `p_takeover`: `{granted: false, limit, holders, sessions}`. With `p_takeover`: displaces the least busy, least recently active holders (`reason = 'takeover'`). Granted: `{granted: true, lease_id, limit, ttl_seconds: 90, heartbeat_seconds: 30, sessions}`. More than 200 sessions in a day returns `too_many_sessions` |
| `vault_session_heartbeat(p_vault_key, p_device_id, p_lease_id, p_active, p_busy, p_flags, p_file_name, p_file_id, p_location, p_written_vv, p_pending)` | object | Extends the lease and records the publish marker. Answers `ok` (with `limit` and `sessions`), `displaced` (with `reason` and the other device's name), or `lost` (`unknown`, `superseded`, `released`, `expired`). A released or lapsed lease is never revived. Applies plan-limit displacement after a downgrade (keeps busy devices, then the most recently active) |
| `vault_session_release(p_vault_key, p_device_id, p_lease_id, p_written_vv, p_pending)` | null | Releases the lease on lock, window close and quit, with the final publish marker |
| `vault_session_abandon(p_vault_key, p_device_id, p_target_device_id)` | null | "Stop waiting for X": ignore that device's publish marker until it reports a new one |

Acquire, heartbeat, release and abandon answer `28000` when not signed in (peek returns null). Acquire
and heartbeat take the `vault-acct:<uid>` and `vault-owner:<vault_key>` guards, which replace the old
per-(user, vault) advisory lock. The `sessions` list of acquire and heartbeat holds the other devices'
rows with `status`, `last_active_at`, `heartbeat_at`, `busy`, `flags`, `written_vv`, `written_at`,
`pending_changes` and `abandoned`. Every heartbeat writes `flags` and `heartbeat_at`; `last_active_at`
moves only while that device is in use, so clients time the side-file flag by `heartbeat_at`.

The client treats any server problem (network, timeout, 5xx, error code, malformed answer) as
"unconfirmed", never as a denial: only a well-formed `granted: false` with holders denies an open.

## Deploy

The deploy script applies the schema, the buckets and the function to one project. It is safe to run
again: it creates what is missing and never drops or renames anything.

```bash
APPWRITE_ENDPOINT=... APPWRITE_PROJECT_ID=... APPWRITE_API_KEY=... \
  node appwrite/scripts/deploy.ts [--seed | --function-only | --skip-function]
```

| Flag | Effect |
|---|---|
| (none) | Schema, buckets and the function |
| `--seed` | Also upserts the tiers and `app_config` rows from `seed.ts` (existing rows are kept). Use on new stacks only |
| `--function-only` | Only the function (settings, variables, new deployment) |
| `--skip-function` | Only the schema and buckets |

The function's variables are set from the same shell environment (see Secrets). A variable that is
not set in the environment is left as it is on the server.

Locally, `npm run appwrite:deploy` does all of this with the env file (`docs/LOCAL_APPWRITE.md`).
For production, run it only after the change works on the local stack, and only with explicit
confirmation. Never seed production; its rows came from the Supabase import.

Tests:

```bash
npm run test:server                      # unit tests (cd appwrite && npm test)
cd appwrite && npx vitest run tests/live # live tests against the local stack
```

## Secrets

Function variables (set by the deploy script from the environment; all but `CONDUIT_API_ENDPOINT` and
`CONDUIT_ABUSE_CHECKS` are stored as secret):

| Variable | Meaning |
|---|---|
| `CONDUIT_SERVICE_SECRET` | Shared secret for service calls (`x-conduit-service` header). The website and scripts need the same value |
| `CONDUIT_API_ENDPOINT` | The API address the function uses. Needed when the public endpoint is not reachable from the function container (local: `http://appwrite-api/v1`) |
| `CONDUIT_ABUSE_CHECKS` | `off` turns off abuse scoring in `submit_fingerprint` (local stacks). Leave unset in production |
| `RESEND_API_KEY` | Sends feedback emails. Without it, feedback is saved but no email goes out |
| `RESEND_CONTACTS_API_KEY`, `RESEND_SEGMENT_ID` | Adds new users to the "Conduit Desktop Users" segment. Without them, nothing is added |
| `FEEDBACK_FROM`, `FEEDBACK_TO` | Feedback email sender and recipient (defaults: `bugs@` and `support@conduitdesktop.com`) |

Deploys and scripts also need `APPWRITE_API_KEY`. Never ship the API key or the service secret in an app.

## Important Implementation Details

- **Raw Realtime rows:** Realtime payloads are not decoded by the function. Single-key tables send the key as `$id`, and JSON columns arrive as strings. Decode before use.
- **Profile right after sign-up:** the `user_profiles` row comes from the `users.*.create` event within a second or two. Code that reads it right after creating an account should retry briefly.
- **Offline support:** if the network is down but the saved session has not expired (or the cached tier is still valid), the app uses cached auth state.
- **Embeds are limited:** `select` supports only these to-one embeds: `user_profiles.tier`, `team_members.team`, `team_invitations.team`, `team_vault_members.team_vault`. For anything else, run two queries and merge client-side.
- **No email on `user_profiles`:** email lives on the Appwrite user. Use `get_team_members_with_email`.
- **Write races:** a write that loses a guard race eight times in a row answers `40001`. Retry later.
- **File size:** 7 MB per file through the function.
