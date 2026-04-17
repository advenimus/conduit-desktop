# Local Supabase for Preview/Dev

Conduit's preview environment runs against a local Supabase stack (Docker). This
replaces the previous cloud preview branch. Production still runs on the shared
Supabase project (`khuyzxadaszwxirwykms`).

## One-time setup

Prerequisites: Docker Desktop, Supabase CLI (`brew install supabase/tap/supabase`).

From the repo root:

```bash
supabase start
```

First run pulls images (several minutes). Subsequent starts are seconds.

When it finishes, it prints the local endpoints and keys. Defaults:

| Endpoint | URL |
|---|---|
| API | http://127.0.0.1:54321 |
| DB | postgresql://postgres:postgres@127.0.0.1:54322/postgres |
| Studio | http://127.0.0.1:54323 |
| Mailpit (email inbox) | http://127.0.0.1:54324 |

The anon key is a well-known static value baked into `env-config.ts` — safe to
commit, same for everyone who runs `supabase start`.

## Seeding data

The first time you run `supabase start`, tables defined in
`supabase/migrations/` are created but the tiers table and other seed data is
empty. Restore from the checked-in preview dump:

```bash
/opt/homebrew/opt/libpq/bin/psql \
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f ~/conduit-backups/conduit-preview-2026-04-17.sql \
  -v ON_ERROR_STOP=0
```

The `ON_ERROR_STOP=0` is intentional: the dump tries to recreate `auth.*`
schema objects that `supabase start` already created. Those errors are
harmless; the important bits (public schema tables + data) apply cleanly.

After restore, verify:

```bash
/opt/homebrew/opt/libpq/bin/psql \
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "SELECT name, features->'mcp_daily_quota' FROM tiers;"
```

You should see `free=50`, `pro=-1`, `team=-1`.

## Daily dev loop

```bash
# terminal 1
supabase start        # leave running

# terminal 2
npm run dev:electron  # uses CONDUIT_ENV=preview → points at localhost:54321
```

If you need the backend (chat cloud sync, device fingerprint):

```bash
# terminal 3
cd ../conduit-backend
# .env.local should point at the local Supabase:
#   SUPABASE_URL=http://127.0.0.1:54321
#   SUPABASE_SERVICE_ROLE_KEY=<value from `supabase status -o env`>
PORT=3001 npm run dev
```

Basic dev (auth, connections, MCP) doesn't require the backend running.

## Creating dev users

The restored `auth.users` rows came from the production preview branch, but
their password hashes may not validate on local Supabase. Easier to create a
fresh local user:

```bash
/opt/homebrew/opt/libpq/bin/psql \
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres" <<'SQL'
-- See Supabase Studio for the UI alternative (http://127.0.0.1:54323)
SELECT auth.admin_create_user('{
  "email": "dev@conduit.local",
  "password": "devdev123",
  "email_confirm": true
}'::jsonb);
SQL
```

Or use Studio (http://127.0.0.1:54323 → Authentication → Users → Add user).

## Writing a migration

Migrations live in `supabase/migrations/` with timestamp-prefixed filenames
(e.g. `20260417_ws2b_tier_feature_flip.sql`). Apply locally with:

```bash
supabase db reset        # wipes + re-runs all migrations from scratch
# or
/opt/homebrew/opt/libpq/bin/psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/migrations/20260417_ws2b_tier_feature_flip.sql
```

When you're ready to apply to production:

```bash
# Dry-run (preview the SQL that will execute):
supabase db push --project-ref khuyzxadaszwxirwykms --dry-run

# Actually apply (you'll be prompted for the DB password):
supabase db push --project-ref khuyzxadaszwxirwykms
```

Run this ONLY after the migration is verified on local. Our rule: never apply
to production without explicit confirmation.

## Stopping Supabase

```bash
supabase stop            # stops containers, preserves data
supabase stop --no-backup   # stops and nukes the volume (fresh start next time)
```

## Ports reference

| Service | Port |
|---|---|
| Supabase API | 54321 |
| Postgres | 54322 |
| Studio | 54323 |
| Mailpit | 54324 |
| Edge Functions | 54321 (routed under /functions) |
| Conduit dev Vite | 1420 |
| Conduit backend dev | 3001 (suggested `PORT=3001`) |

## Troubleshooting

**"Docker daemon not running"** — open Docker Desktop, wait for the whale to
settle, then re-run.

**"port 54321 already in use"** — another Supabase stack is running. Stop it
first: `supabase stop` in whichever project owns it.

**Desktop app shows empty tier capabilities** — confirm the dump was applied
and users were seeded. `supabase status -o env` will show a working anon key;
curl `/rest/v1/tiers?select=name` with it to confirm RLS allows your session.
