# Conduit API on Appwrite: client contract

Every app (desktop, iOS, website) talks to one Appwrite Function, `api`. It takes the same requests
the apps used to send to Supabase (PostgREST tables, RPCs, storage) and enforces the same rules:
the old RLS policies, triggers, SQL functions and storage policies, ported to TypeScript in
`appwrite/src/api/`. Source of truth for behavior: that code and its tests (`appwrite/tests/`).

## Environments

| | Endpoint | Project ID |
|---|---|---|
| Local dev (Docker on the Mac) | `http://localhost:8085/v1` (from a phone on the LAN: `http://<mac-name>.local:8085/v1`) | `conduit-dev` |
| Production | `https://appwrite.cloudwise.ca/v1` | `6acf9d610020fad67ba9` |

Registered platforms in local dev: web `localhost`; Apple `com.conduitapp.ios`, `com.conduitapp.ios.tests`,
`com.conduitapp.ios.uitests`. Mail from local Appwrite lands in Mailpit at `http://localhost:8025`.

## Accounts and sessions

- **User IDs are lowercase UUIDs.** Every table keys users by UUID, so a client that creates an
  account must pass its own ID: `account.create(userId: UUID().uuidString.lowercased(), email, password, name)`.
  Imported Supabase users keep their old UUIDs.
- A new account gets its `user_profiles` row (Free plan) from the `users.*.create` event within a
  second or two. Clients that read the profile right after sign-up should retry briefly on "no row".
- Sign in: `account.createEmailPasswordSession(email, password)`.
- **MFA.** When the account has MFA on, the session is not usable until the second step is done:
  `account.get()` fails with type `user_more_factors_required`. Then `account.listMfaFactors()`
  (`totp`, `email`, `recoveryCode`), `account.createMfaChallenge(factor)`, and
  `account.updateMfaChallenge(challengeId, otp)`. Users imported with an authenticator app start
  with the **email** factor only until they add a new authenticator.
- Email verification and password recovery links come back as `userId` + `secret` query
  parameters; finish with `account.updateVerification` / `account.updateRecovery`.
- A blocked user (suspended) cannot create sessions.
- Sign-out: `account.deleteSession("current")`.

## Calling the api function

Synchronous execution, POST, path `/`, JSON body, as the signed-in user:

```
functions.createExecution(functionId: "api", body: <json>, async: false, path: "/", method: POST,
                          headers: ["content-type": "application/json"])
```

The response is `execution.responseStatusCode` and `execution.responseBody`:

```json
{ "data": <result or null>, "count": <number or null>, "error": null }
{ "data": null, "error": { "code": "42501", "message": "...", "details": null, "hint": null } }
```

Error codes keep their Postgres meaning: `42501` not allowed, `23514` plan or check rule
(`team_full: ...`, `team_inactive: ...`), `23505` duplicate, `23503` missing reference, `23502`
missing value, `22023`/`22P02` bad input, `28000` not signed in, `PGRST116` `.single()` did not get
exactly one row (status 406), `40001` lost a write race eight times in a row (retry later),
`XX000` server bug. Anonymous callers cannot execute the function at all.

A TypeScript client with the supabase-js call shape lives in `appwrite/src/client/index.ts`
(`ConduitDb`: `from().select().eq()...`, `rpc()`, `storage.from()`), with a node-appwrite transport
in `appwrite/src/client/appwrite-transport.ts`. Native clients build the same JSON.

### Table queries

```json
{
  "kind": "query",
  "op": "select" | "insert" | "upsert" | "update" | "delete",
  "table": "vault_entries",
  "select": "*, team:teams ( name )",
  "filters": [{ "column": "vault_id", "op": "eq", "value": "<uuid>" }],
  "order": [{ "column": "created_at", "ascending": false }],
  "limit": 50, "offset": 0,
  "count": "exact", "head": false,
  "single": "one" | "maybe",
  "rows": {} | [{}],
  "values": {},
  "onConflict": "user_id, device_id",
  "ignoreDuplicates": false,
  "returning": true
}
```

- Filter ops: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in` (value is a list), `is` and `isnot`
  (value `null`, `true` or `false`). Comparisons with NULL never match, as in SQL.
- `select` accepts `*`, a column list, and to-one embeds `alias:table ( cols )` or `table(*)`.
  Embeds: `user_profiles.tier|tiers`, `team_members.team|teams`, `team_invitations.team|teams`,
  `team_vault_members.team_vaults|team_vault`.
- Writes return rows only when `returning` is true (supabase-js: chaining `.select()`).
- `single: "one"` returns an object or `PGRST116`; `"maybe"` returns an object or null.
- Rows come back with the original column names and types: UUIDs lowercase, timestamps ISO 8601
  UTC (`2026-10-14T12:00:00.000Z`), JSON columns as JSON values.

### RPCs

```json
{ "kind": "rpc", "fn": "vault_session_acquire", "args": { "p_vault_key": "<uuid>", ... } }
```

| Function | Args | Returns |
|---|---|---|
| `vault_session_peek` | `p_vault_key`, `p_device_id`, `p_platform?`, `p_app_version?` | object or null |
| `vault_session_acquire` | `p_vault_key`, `p_device_id`, `p_session_nonce`, `p_device_name`, `p_platform`, `p_app_version`, `p_file_name`, `p_file_id`, `p_location`, `p_takeover?`, `p_claim?` | object |
| `vault_session_heartbeat` | `p_vault_key`, `p_device_id`, `p_lease_id`, `p_active`, `p_busy?`, `p_flags?`, `p_file_name?`, `p_file_id?`, `p_location?`, `p_written_vv?`, `p_pending?` | object |
| `vault_session_release` | `p_vault_key`, `p_device_id`, `p_lease_id`, `p_written_vv?`, `p_pending?` | null |
| `vault_session_abandon` | `p_vault_key`, `p_device_id`, `p_target_device_id` | null |
| `vault_owner_release` | `p_vault_key` | object |
| `upsert_vault_entry_versioned` | the 23 `p_*` entry fields | `[{ success, current_version }]` |
| `get_team_members_with_email` | `p_team_id` | rows with `user_email`, `user_display_name` |
| `rate_limit_hit` (service only) | `p_key`, `p_limit`, `p_window_seconds` (at most 86400) | `{ allowed, remaining, retry_after }` (seconds) |

Answers keep the exact JSON shapes of the old SQL functions (see
`supabase/migrations/20260926150905_personal_vault_session_rpcs.sql` and later). A missing user
session gives `28000`; `vault_session_peek` without a session returns `null`.

### Storage

```json
{ "kind": "storage", "bucket": "vaults", "action": "upload", "path": "<uid>/<vault>/vault.enc", "body": "<base64>", "upsert": true, "contentType": "application/octet-stream" }
{ "kind": "storage", "bucket": "vaults", "action": "download", "path": "<uid>/manifest.json" }
{ "kind": "storage", "bucket": "vaults", "action": "list", "path": "<uid>/<vault>/backups", "limit": 200, "sortBy": { "column": "created_at", "order": "desc" } }
{ "kind": "storage", "bucket": "vaults", "action": "remove", "paths": ["<uid>/vault.enc"] }
```

- Paths and rules are the old Supabase ones: users touch only `<their uid>/...`; `vaults` writes
  need cloud backup on the plan, an allowed file name, and a free slot (Pro: 25 snapshots per vault,
  10 vaults). `feedback-logs` is upload-only for users.
- `download` returns `{ "body": "<base64>", "contentType": "..." }`; a missing or foreign file is
  error code `404`. `upload` without `upsert` on an existing path is `409`.
- `list` returns direct children like supabase-js: files have `id` and `metadata.size`; folders
  have `id: null`.
- Max file size is 10 MB. Execution bodies are capped near 10 MB of base64, so files over 6 MB skip
  the body. Upload: create the file in bucket `uploads` with the user's session (any ID, default
  permissions), then send `upload` with `"staged": "<fileId>"` instead of `body`; the function checks
  the caller created it, moves the bytes and deletes the staged file. Download: the answer is
  `{ "bucket", "fileId", "contentType" }` with no `body`; fetch
  `GET /storage/buckets/{bucket}/files/{fileId}/download` with the session (the function grants the
  owner read first). Staged files nobody claimed are deleted after an hour.
- A non-2xx execution status is an error even when the body is empty (a crashed or timed-out run).

## Realtime

Subscribe with the Appwrite Realtime client using the user's session. Rows only reach users who may
read them (vault rows: members of that team vault; lease rows: their owner).

| Data | Channel | Query |
|---|---|---|
| Lease rows for this device | `tablesdb.conduit.tables.personal_vault_sessions.rows` | `Query.equal("device_id", [deviceId])` |
| Team vault entries / folders / password history / folder grants / locks | `tablesdb.conduit.tables.<table>.rows` | `Query.equal("vault_id", [vaultId])` |

Realtime payloads are **raw Appwrite rows**, not api-decoded rows:

- The key of single-key tables is `$id` (for example `vault_entries.id` arrives as `$id`).
  `personal_vault_sessions` has a composite key, so its `user_id`, `vault_key`, `device_id` are
  normal fields.
- JSON columns arrive as JSON **strings**: `busy`, `flags`, `written_vv` (sessions), `details`.
  Parse them before use.
- Events: `...rows.<id>.create`, `.update`, `.delete` in `events`.

## Service calls (website and scripts only)

Server code with an API key can call the function as the trusted service by adding the header
`x-conduit-service: <CONDUIT_SERVICE_SECRET>`. Row rules are skipped; triggers still run (seat
limits, membership sync, cleanup). Never ship the API key or the service secret in an app.

## Local test accounts

`/Volumes/SSD Storage/.conduit-dev/appwrite/conduit-dev.env` holds the local admin key and service
secret. `appwrite/tests/live/env.ts` shows how to create a user with a UUID, open a session, wait
for the profile, and set a plan.
