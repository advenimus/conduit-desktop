# Local Appwrite for Preview/Dev

Conduit's preview environment runs against a local Appwrite stack in Docker. Production runs on the
self-hosted Appwrite at `https://appwrite.cloudwise.ca/v1` (project `6acf9d610020fad67ba9`). How the
backend works is in `docs/APPWRITE.md`; the request format is in `docs/appwrite-migration/API_CONTRACT.md`.

| What | Value |
|---|---|
| Appwrite version | 2.3.0 (same as the production server) |
| API endpoint | http://localhost:8085/v1 |
| Project ID | `conduit-dev` |
| Console | http://localhost:8085 |
| Mailpit (email inbox) | http://localhost:8025 |

## One-time setup

Prerequisites: Docker Desktop, running. Nothing else to install.

From the repo root:

```bash
npm run appwrite:setup
```

This runs `appwrite/scripts/setup-local.ts`. It:

1. Installs Appwrite 2.3.0 in Docker (PostgreSQL database, HTTP port 8085, HTTPS port 8445).
2. Points Appwrite's mail at a Mailpit container (`conduit-appwrite-mailpit`, port 8025) and lets
   functions reach the API on the internal address `http://appwrite-api/v1`.
3. Creates the console account, the `conduit-dev` project, its platforms (web `localhost`; Apple
   `com.conduitapp.ios`, `com.conduitapp.ios.tests`, `com.conduitapp.ios.uitests`) and an API key.
4. Writes the env file `conduit-dev.env` in the stack folder.
5. Deploys the schema, seeds the plan tiers and `app_config`, and deploys the `api` function
   (`node appwrite/scripts/deploy.ts --seed`).

The first run pulls images and takes several minutes. It is safe to run again; it only adds what is missing.

### Where the stack lives

The stack folder is `CONDUIT_APPWRITE_DIR` when set. Otherwise it is
`/Volumes/SSD Storage/.conduit-dev/appwrite` if that folder exists, else `~/.conduit-dev/appwrite`.
The path has a space on the SSD, so quote it in shell commands.

### The env file

`<stack folder>/conduit-dev.env` (mode 600) holds:

| Key | Meaning |
|---|---|
| `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID` | `http://localhost:8085/v1`, `conduit-dev` |
| `APPWRITE_API_KEY` | Admin key for scripts, deploys and the verify harness |
| `CONDUIT_SERVICE_SECRET` | Lets scripts call the `api` function as the trusted service |
| `CONDUIT_API_ENDPOINT` | `http://appwrite-api/v1`, the address the function uses to reach the API |
| `CONDUIT_ABUSE_CHECKS` | `off`. Every local test account shares this Mac's hardware ID, which the abuse check would flag |
| `CONSOLE_EMAIL`, `CONSOLE_PASSWORD` | The console login (`dev@conduit.local` and a random password) |

Never commit this file or paste its keys anywhere. To load it into a shell:

```bash
set -a; source "/Volumes/SSD Storage/.conduit-dev/appwrite/conduit-dev.env"; set +a
```

Live server tests and other scripts read it from `CONDUIT_APPWRITE_ENV` when you set that.

## Daily dev loop

```bash
npm run appwrite:start   # starts the stack if it is down; redeploys appwrite/ if it changed
npm run dev:electron     # CONDUIT_ENV=preview, talks to localhost:8085
npm run appwrite:stop    # stops the stack and Mailpit; data is kept
```

`npm run appwrite:deploy` does the same as `appwrite:start`. Both redeploy only when files under
`appwrite/` changed since the last deploy. A stamp file, `.deployed-conduit-dev` in the stack folder,
holds the fingerprint of the last deploy.

Sign-in happens on the website. In preview the app opens `http://localhost:3000`, so run the website
locally against this stack, or skip the website with `npm run dev:account -- --signin` (below).

Unpackaged dev builds also read two overrides:

- `CONDUIT_DEV_APPWRITE_ENDPOINT`: another endpoint. It must be an http(s) loopback URL. The verify
  harness uses it to put a cut-able proxy between one test device and the stack.
- `CONDUIT_DEV_APPWRITE_PROJECT`: another project ID.

## Test accounts

Make an account and sign the running dev app in with it:

```bash
npm run dev:account -- --email you@example.com --plan pro --password '<choose one>' --signin
```

- `--plan` is `free`, `pro` or `team` (default `pro`).
- Without `--password` a new account gets a random password, printed once.
- `--signin` sends the dev app a real `conduit://auth/callback` link with a fresh session.
- It refuses anything but a local stack.

For an account with MFA turned on (to test the second step), load the env file and run:

```bash
node appwrite/scripts/dev-user.ts --email you@example.com --password '<pw>' --tier pro --mfa
```

On a local stack the desktop app does not require MFA. Production does.

You can also manage users in the console (Auth > Users) at http://localhost:8085.

## Opening a vault owned by another account

A vault owned by your production account is refused on the local stack ("This vault belongs to a Conduit account. Sign in with that account to open it."). Start the app with the owner check off:

```bash
npm run dev:electron:owner-bypass
```

This only works in an unpackaged preview build, never writes the vault's owner tag, and shows an "Owner check skipped (dev)" banner. `CONDUIT_DEV_VAULT_DEVICE_LIMIT` is the sibling override for the device limit. Both are explained in `docs/PLAN_ENFORCEMENT.md` section 4.12.

## Mail

Every email the local stack sends (verification, password recovery, MFA codes) lands in Mailpit at
http://localhost:8025. Nothing leaves the Mac.

## Console login

Open http://localhost:8085 and sign in with `CONSOLE_EMAIL` and `CONSOLE_PASSWORD` from the env file.
The data lives in database `conduit`: one table per old Postgres table, plus `guards` (internal).
Files live in the buckets `vaults` and `feedback-logs`. The function is `api`; its executions and logs
are under Functions.

## Server tests

```bash
npm run test:server                      # unit tests of appwrite/ (no stack needed)
cd appwrite && npx vitest run tests/live # live tests against the local stack
```

## Writing a server change

The schema is code in `appwrite/src/schema/tables.ts`. Rules, triggers and RPCs are TypeScript in
`appwrite/src/api/`. There are no SQL migrations any more.

1. Change the code and add a unit test under `appwrite/tests/unit/`.
2. `npm run test:server`.
3. `npm run appwrite:deploy` to put it on the local stack, then try it in the app or with `/verify`.
4. Deploy to production only after it works locally, and only with explicit confirmation
   (see `docs/APPWRITE.md`, Deploy).

The deploy adds missing tables, columns and indexes. It never drops or renames anything. A column
rename or removal needs a manual step in the console.

## Another local project

To add a second project next to `conduit-dev` (for example an import rehearsal):

```bash
CONDUIT_APPWRITE_PROJECT=<id> node appwrite/scripts/setup-local.ts
```

It writes `<id>.env` in the same stack folder.

## Resetting

- One test account: delete it in the console (Auth > Users). The `users.*.delete` event removes its
  rows and files.
- The function only: delete `.deployed-conduit-dev` in the stack folder, then `npm run appwrite:deploy`.
  Or load the env file and run `node appwrite/scripts/deploy.ts --function-only`.
- Everything: in the stack folder run `docker compose down -v` and `docker rm -f conduit-appwrite-mailpit`,
  delete `conduit-dev.env` and `.deployed-conduit-dev`, then run `npm run appwrite:setup` again. Keep
  the env file and the stack together: a saved API key or console password does not work on a new stack.

## Ports reference

| Service | Port |
|---|---|
| Appwrite HTTP (API and console) | 8085 |
| Appwrite HTTPS | 8445 |
| Mailpit | 8025 |
| Conduit dev Vite | 1420 |
| Website (preview `websiteUrl`) | 3000 |

## Troubleshooting

**"Docker is not running"**: open Docker Desktop, wait until it is ready, then rerun.

**The stack is slow, or containers restart**: Appwrite runs many containers. Give Docker Desktop at
least 4 GB of memory (Settings > Resources).

**The first call after a pause takes about a second**: the function's container stops after 60 s
without calls (`_APP_FUNCTIONS_INACTIVE_THRESHOLD`) and starts again on the next call. Warm calls take
about 16 ms. Lease heartbeats keep it warm while a vault is open.

**A change in `appwrite/` does not show up**: run `npm run appwrite:deploy`. If it still does not,
delete `.deployed-conduit-dev` and deploy again. Check the function's deployment and execution logs in
the console.

**`... not found. Run npm run appwrite:setup first`**: the env file is missing. Run the setup.

**Port 8085 already in use**: another Appwrite stack is running. Stop it, or ask its owner first.

**The desktop app shows no plan features**: check the tiers were seeded (console, table `tiers`) and
that the account has a `user_profiles` row. A new account gets its row from the `users.*.create`
event within a second or two.

## Testing with an iPad or iPhone

iOS Debug builds use this same local stack; Release builds always use production.

- From a device on the same network the endpoint is `http://<mac-name>.local:8085/v1`, project `conduit-dev`.
- The device and the Mac must be on the same network. The first connection may ask on the Mac to
  allow Docker incoming connections, and on the device to allow local network access.
- Make a test account with `npm run dev:account` (above) and use the same email and password in the
  iOS app's Sign In. For sync, keep the test vault in iCloud Drive and open it on both.
