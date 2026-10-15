# Supabase to Appwrite: production readiness and cutover

Nothing here starts until the local test gate (plan Phase 8.5) has passed and the owner signs off.
Steps marked **Owner** need access only the owner has.

## 1. Production server checks (Owner)

On the server that runs `https://appwrite.cloudwise.ca`, in Appwrite's `.env`:

| Setting | Needed value | Why |
|---|---|---|
| `_APP_FUNCTIONS_RUNTIMES` | includes `node-22` | the `api` function runtime |
| `_APP_EXECUTOR_SECRET` | a long random value, not `your-secret-key` | executor auth |
| `_APP_FUNCTIONS_INACTIVE_THRESHOLD` / `_APP_COMPUTE_INACTIVE_THRESHOLD` | 3600 or more | keeps the `api` function warm (a cold start adds about 1 s) |
| `_APP_SMTP_*` | Resend SMTP (`smtp.resend.com`, port 465 or 587, user `resend`, an API key with send access) | verification, recovery and MFA email codes |
| `_APP_DB_ADAPTER` | `mongodb` (checked 2026-10-15) | the local stack uses `postgresql`; staging on this server passed the live tests |
| `_APP_OPTIONS_ABUSE` | `enabled` | Appwrite's own rate limits |

Also on the server:
- Password sign-in: the 2.3.0 upgrade (2026-10-07) set `_APP_PWNED_PASSWORDS_DSN=mock://`, which Appwrite refuses in production, so every password call returned HTTP 500 in every project. Fixed 2026-10-15: `hibp://api.pwnedpasswords.com` (backup `.env.pre-pwned-dsn-*`).
- ClickHouse: done 2026-10-15 with `docker-compose.override.yml` mounting `clickhouse-quiet.xml` (CPU went from 108% to about 5%).
- Server email is sent as KHM Tracker; the Conduit projects (prod and staging) have their own SMTP: Resend, `Conduit <noreply@conduitdesktop.com>`, a send-only key for conduitdesktop.com.
- Server: `/root/docker/appwrite` on SVR-CW-APP-1 (Leaseweb, Montréal). It also runs KHM Tracker.
- ClickHouse (Appwrite's usage stats) writes its own system logs nonstop and can use a full CPU core,
  which slows every API call. Check `docker stats`; if it is busy, mount the same
  `clickhouse-quiet.xml` the local stack uses (`appwrite/scripts/setup-local.ts`) into
  `/etc/clickhouse-server/config.d/` and restart it.
- Nightly backup: `/root/docker/appwrite/backup.sh` from `/etc/cron.d/appwrite-backup` at 03:30, 14 days kept in `/root/backups/nightly` (set up 2026-10-15). **Not done:** a copy off the server. A restore needs `--ulimit nofile=262144:262144` on the MongoDB container, or WiredTiger runs out of files.
- Uptime alert on `https://appwrite.cloudwise.ca/v1/health/version`, a disk space alert, and TLS renewal confirmed.

## 2. Production project setup

Done 2026-10-15: API keys (`cutover-deploy` expires 2026-11-15, `website` for Vercel), platforms, session limit 100, SMTP, deploy with the plan rows seeded (same IDs as Supabase), and an App Review account `appreview@conduitdesktop.com` (Pro). Vercel has the four `APPWRITE_*`/`CONDUIT_SERVICE_SECRET` variables: Production points at prod, Preview at `conduit-staging`.

1. **Owner**: in the Appwrite console, project "Conduit Desktop" (`6acf9d610020fad67ba9`), create an API key with the scopes listed in `appwrite/scripts/setup-local.ts` and give it to Claude (or run step 3 yourself).
2. **Owner**: platforms: Web `conduitdesktop.com` and `www.conduitdesktop.com`; Apple `com.conduitapp.ios`.
3. Deploy schema, buckets and the function (no seed; prod rows come from the import):
   ```
   APPWRITE_ENDPOINT=https://appwrite.cloudwise.ca/v1 APPWRITE_PROJECT_ID=6acf9d610020fad67ba9 \
   APPWRITE_API_KEY=... CONDUIT_SERVICE_SECRET=<new random> \
   FEEDBACK_FROM='Conduit Bug Reports <bugs@conduitdesktop.com>' FEEDBACK_TO='Conduit Support <support@conduitdesktop.com>' \
   RESEND_API_KEY=<send key> CONDUIT_API_ENDPOINT=https://appwrite.cloudwise.ca/v1 \
   node appwrite/scripts/deploy.ts
   ```
   `CONDUIT_API_ENDPOINT` is required on this server: uploads from the function fail through the default internal endpoint.
   Leave `RESEND_CONTACTS_API_KEY` and `RESEND_SEGMENT_ID` out until after the import, or every imported account is posted to the Resend audience again. Add them afterwards with `--function-only`.
4. Check the `uploads` bucket exists with permission `create("users")` (deploy creates it; it holds
   big backup uploads for up to an hour).
5. Auth settings in the console: email/password on; sessions 1 year; password minimum 8 (Supabase allowed 6; existing hashes still work); the apps pass the link targets themselves (`https://conduitdesktop.com/auth/verify` for verification, `/auth/update-password` for recovery), so only the template wording needs editing; both hosts must be Web platforms or Appwrite refuses the URL. "Invalidate sessions" (Auth > Security) decides whether a password change on the website signs the user out of the desktop app and iPhone; the owner chose on (2026-10-15), and prod and local both have it on. Sessions limit (Auth > Policies > Sessions) is 100 per user on prod and local, set 2026-10-15; Appwrite's default of 10 quietly signs out a user's oldest app session.

## 3. Rehearsal on a staging project (plan Phase 8.5 round 3)

1. **Owner**: create project `conduit-staging` on the server, an API key, the same platforms.
2. Deploy as in step 2.3 with `--seed`.
3. Import a copy of prod: `node appwrite/scripts/import-supabase.ts` with `SUPABASE_DB_URL` (prod connection string, **Owner**), `SUPABASE_URL=https://khuyzxadaszwxirwykms.supabase.co` and `SUPABASE_SERVICE_ROLE_KEY` (**Owner**). Run `--dry-run` first.
4. Point a release-candidate desktop build and a TestFlight iOS build at staging, run the checklist in the plan, then delete the staging project.

## 4. Cutover evening

Before: the iOS build pointing at prod Appwrite is approved with manual release (1.2.0 build 114 uploaded 2026-10-15; owner decided to cut over only after approval); the desktop tag and the website PR are ready; prod project deployed (step 2) and empty.

1. Freeze Supabase: set `app_config.min_app_version` to the new versions (old apps show "update required"), and turn off sign-ups in Supabase Auth.
2. Import into prod: `node appwrite/scripts/import-supabase.ts --archive-dir <archive folder>` with `SUPABASE_DB_ROLE=postgres` and a fresh 5-minute CLI login (the round 2 and 3 runs used the Supabase CLI's `cli/login-role` endpoint). The project already holds the plan rows and the App Review account; neither clashes with imported rows. Expect: about 260 users, 93 on the email-code MFA bridge, about 100 files. The script ends with a count check.
3. Add `RESEND_CONTACTS_API_KEY` and `RESEND_SEGMENT_ID` with `deploy.ts --function-only`.
4. Vercel: set `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_API_KEY`, `CONDUIT_SERVICE_SECRET` on the website, merge the website PR.
5. Release iOS, push the desktop tag.
6. Check end to end: sign in on the website (an imported TOTP user gets an email code, then sets up a new authenticator), desktop sign-in handoff, iOS sign-in, a Pro user's plan, a team owner's team and seats, a Stripe test webhook, a cloud backup upload and restore, a feedback report email.

Rollback: before step 4, turn Supabase sign-ups and the old minimum version back. After the apps ship, fix forward.

## 5. After 30 days (plan Phase 10)

Final `pg_dump` and storage export archived; delete the Supabase project and its preview branch; remove Supabase secrets from Vercel and GitHub; delete `supabase/` from this repo and the two Supabase GitHub workflows in conduit-backend; archive conduit-backend.
