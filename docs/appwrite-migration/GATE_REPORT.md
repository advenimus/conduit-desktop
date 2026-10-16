# Local test gate (plan Phase 8.5)

Nothing in the cutover runbook starts until the owner signs off here.

## Round 1: clean local data (local Appwrite 2.3.0 in Docker), 2026-10-14

### Server (`appwrite/`)

| Check | Result |
|---|---|
| Unit tests (`npm test`): ported SQL rule tests (ownership, device caps, min version, backups, teams, races), storage, jobs, rate limit, unit of work, client | 58 pass |
| Live tests against local Appwrite (`npx vitest run tests/live`): row rules, O9 and T4 races, unique pairs, storage incl. a 9 MB file, team Realtime reaches members only, user delete cascade | 10 pass |

### Desktop (this repo)

| Check | Result |
|---|---|
| `npx tsc --noEmit`, `npm run lint` (0 errors), `npm run build` | pass |
| Unit tests (`npx vitest run`) | 4,549 pass |
| `/verify-sync` (8) | 8 pass |
| `/verify-ownership` (9) | 9 pass |
| `/verify-mcp` (11) | 11 pass |
| backup (5), copies (5), lifecycle (6), password (4), resilience (5) | 22 of 25 pass; the 3 failures also fail on `main` with Supabase (below) |
| startup (12), smoke | pass (earlier run the same day) |

Failures that are not from the migration (each re-run on `main` against local Supabase, same failure):
- `backup/rollback-syncs`: the rollback reaches the second device (checked in the vault file), but the last on-screen check looks for an entry name while the side bar is hidden.
- `password/change-while-other-closed`: device B shows "Syncing paused" instead of opening its own copy with the old password.
- `resilience/import-export`: known before the migration.

Local stack fixes found during the gate (both also apply to the production server, see the runbook):
- ClickHouse spent a full core on its own system logs, which slowed every call enough to make a lease test flaky.
- Postgres ran as PID 1 and restarted every connection when a health check timed out.

### iOS and website

Run by separate workers in their own worktrees; full results in each repo's `docs/appwrite-migration/`.

| App | Result |
|---|---|
| iOS (`conduit-iOS-private`, branch `advenimus/migrate-to-appwrite`) | 1,202 unit, 249 ConduitSync, 6 live api and the live UI tests pass on the simulator; session in the Keychain, offline launch stays signed in, 9 MB backup round trip, the emailed link confirms through the website's `/auth/verify` |
| Website (`conduit-website`, branch `advenimus/migrate-to-appwrite`) | tsc, build, 88 unit, 20 live route tests and the browser scenarios pass; sign-in, MFA, forgot, sign-up, desktop hand-off and invite accept are rate limited |

### Checked by hand

- 2026-10-14, owner: desktop sign-in hand-off from the local website into `npm run dev:electron` works. On macOS the `conduit://` link goes to whichever `Electron.app` Launch Services prefers; with several worktrees, re-register this one (`lsregister -f`) if a blank Electron window opens instead.

- 2026-10-15, test agent driving the real apps (desktop harness devices plus the iOS 27 simulator, signed Debug):
  - Desktop: plan shown for Free, Pro and team; Free one-device limit; take-over and take-back; team vault folder and entry add, edit, delete seen live by a second member in 2 to 3 s; cloud backup upload, list, restore; master password change; forgot password through Mailpit; sign out stays signed out after relaunch. All pass.
  - iOS: 1,202 unit, 6 live api, 11 of 12 live UI tests run pass (MFA code test passed on retry); with desktop on the same account: take-over both ways, team entry both directions, desktop cloud backup opens on the phone, sign out. All pass.
  - Not regressions (same on `main`): the website has no change-password page for a signed-in user; a second device of the same user gets no live team update (`team-sync.ts` skips its own `updated_by`); iOS has no live team updates, it sees changes on refresh.
  - First attempts of three scenarios timed out while Docker's VM was out of memory (local Supabase and Appwrite both running); all passed on retry.

### Checklist still to run by hand (owner or Claude with the apps side by side)

- Desktop and iPhone on the same account at once (take-over both ways, team vault edit seen live).
- Real iPhone on the same Wi-Fi (`.local` address), not only the simulator.
- Stripe test checkout creating a team (needs the Stripe test key in the website's `.env.local`).
- Feedback with logs and a screenshot arriving by email (needs a Resend key on the local function).

## Round 2: a copy of prod data in local Appwrite (2026-10-15)

- Import from prod Supabase into local project `conduit-prodcopy` (`import-supabase.ts --archive-dir`): 263 users (93 on the email-code MFA bridge), every table, 103 files (9.7 MB); the built-in verify step matches Supabase. Legacy AI tables archived to JSON.
- Supabase access came from the Supabase CLI login: a 5-minute temporary database login (`SUPABASE_DB_ROLE=postgres` is switched to after connecting) and the service role key from the management API, both kept out of the chat.
- Hand test by a test agent driving the website (port 3001, `CONDUIT_ENFORCE_MFA=true`) and an isolated desktop app against the copy, 12 of 12 pass:
  - TOTP user: emailed code, forced new authenticator, then the authenticator on the next sign-in (no email).
  - Pro user: email code bridge, plan shows Pro; desktop hand-off signs in with plan `pro`; 48 imported cloud backups listed and one downloads up to the master password step.
  - Team owner: team, Admin role and "1 of 2 seats used" on the website; team vault listed on desktop, asks for team access setup.
  - Unconfirmed email: sign-in refused with a new confirmation link, the link confirms, then authenticator setup.
  - Signed-in password change (wrong current password and mismatch refused, old password refused after, changed back); wrong password and unknown email both say "Invalid login credentials".
  - Free one-device limit and take-over between two devices (0.9 s).
  - All 103 files present with the same size; 263 users and 263 profiles, no orphans; every MFA user has a verified email.
  - Not migration faults: the Pro account shows "Subscription: Free" because its Supabase row has no Stripe subscription either; the desktop backup list stays empty until a cloud-backed vault is unlocked (`cloud-sync.ts:353`), as before.

## Round 3: staging project on the server (2026-10-15)

- Project `conduit-staging` on `appwrite.cloudwise.ca`, deployed with `deploy.ts --seed`, then a full import of prod data: same counts as round 2, 2 min 13 s.
- The server's database is MongoDB (`_APP_DB_ADAPTER=mongodb`), the local stack's is Postgres. Two differences found and fixed:
  - MongoDB refuses a second index over the same columns (`cloud_files` had a plain and a unique index on `bucket, path`); deploy now keeps only the unique one.
  - Uploads from the function fail through the server's default internal endpoint; with `CONDUIT_API_ENDPOINT=https://appwrite.cloudwise.ca/v1` they work.
- Server live tests (`npx vitest run tests/live` with `CONDUIT_APPWRITE_ENV` pointing at a staging env file): 10 of 10 pass, including the O9 and T4 races, unique pairs, a 9 MB backup and team Realtime. 100 function calls with no errors, median 0.16 s, 90th percentile 0.7 s.
- Server fix: every email-and-password call returned HTTP 500 in every project (also KHM Tracker). Cause: the 2.3.0 upgrade set `_APP_PWNED_PASSWORDS_DSN=mock://`, which Appwrite refuses in production. Now `hibp://`; sign-up, sign-in, wrong password (401) and password change all work.
- Hand test by a test agent over the internet (website on localhost against staging, isolated desktop app through a loopback forwarder), 11 of 12 pass:
  - New sign-up (verification email about 1 s), TOTP bridge (email code 5.6 s, then new authenticator, then authenticator only), Pro plan, team page, forgot password (1.9 s), signed-in password change, team invite and accept up to the seat limit (third invite refused). Emails went to Resend test addresses only.
  - Desktop: hand-off sign-in 1.3 to 2.0 s, plan Pro, 50 backups listed with a vault open, backup upload 1.3 to 1.5 s and restore, Free one-device take-over (other device told in 1.0 s, take-back 0.6 s), feedback with a screenshot to support (logs are off in unpackaged builds).
  - 570 function calls, no failures, median 43 ms, p90 217 ms, none over 2 s.
  - Not run: team vault live update between two desktop devices. The abuse check (more than three accounts on one Mac) suspended the test accounts, as designed. Covered instead by the live test (team Realtime reaches members only) and by the desktop's own Realtime client run straight against staging: 10 of 10 events delivered, no errors. The agent's Realtime errors came from its forwarder.
- Server note: a Realtime `subscribe` sent after the `authentication` reply returns "Server Error" on this server; sent right after `authentication` (what the desktop and Appwrite's SDK do) it works.
- The live tests now create users from a bcrypt hash plus a server-made session, the same path imported accounts take.

## Server operations (2026-10-15)

- ClickHouse quieted (108% CPU to about 5%).
- Nightly backup at 03:30 server time: `/root/docker/appwrite/backup.sh` (MongoDB dump, storage, functions, builds, config; 14 days kept in `/root/backups/nightly`). First run 84 MB in 13 s; a test restore into a fresh MongoDB took 39 s. Still on the same server: an off-server copy is not set up.

## Sign-off

- [ ] Owner sign-off on rounds 1 to 3
