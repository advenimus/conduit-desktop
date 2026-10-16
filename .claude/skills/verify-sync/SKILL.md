---
name: verify-sync
description: Run only the live sync and device-limit suite (Free take-over and take-back, Pro merge and conflict review, plan changes, sign-out lease release, signed-out owner claims, legacy writer, file safety) against the real Conduit app and a local Appwrite. Use after changing electron/services/sync/, electron/services/vault-session/, src/components/sync/, the vault unlock or lock flow, or the vault_session_* RPCs in appwrite/src/api/rpc/sessions.ts, or when asked to verify sync or device limits live. Fully isolated; takes about 75 seconds.
---

# /verify-sync: sync and device-limit suite

Runs `npm run verify:sync` (`node scripts/verify/run.mjs sync`). Real Electron devices share one
"cloud" folder, sign in as generated test users on a local Appwrite, and are driven like a user. The
spec under test is `docs/MULTI_DEVICE_SYNC.md` (sections 5, 6 and 7); the harness reference is
`scripts/verify/README.md`. Every suite at once is the `verify` skill; password changes, the vault
lifecycle, copies, backups and offline or team resilience are the `verify-data` skill.

## What it proves

Each scenario uses its own devices (`s1a`, `s1b`, ...) and its own `Vault.conduit`.

| Scenario | In plain words |
|---|---|
| `free-takeover-server` | On Free, device B opens a vault A has open, is offered a take-over ("On the Free plan a vault can be open on one device at a time."), takes it and gets A's data; A is locked out and offered "Use here instead". |
| `take-back` | A presses "Use here instead" and gets the vault back; B is locked out. |
| `pro-merge-and-conflict` | On Pro both devices stay open. Edits to different fields merge with no conflict. The same field edited on both, and an edit against a delete, show up as conflicts; they are resolved in the review panel ("Keep item" for the delete) and both devices end the same. |
| `downgrade-and-upgrade` | Pro to Free with two devices open locks out exactly one (lease reason `plan_limit`, plan-limit message) while the other stays unlocked; back to Pro the locked-out device reopens with no take-over and the other is not disturbed. |
| `signout-releases-lease` | Signing out frees the device's server lease within seconds. |
| `signed-out-claims` | With nobody signed in (counts as Free), the owner claim inside the vault file still drives the take-over dialog and locks A out; B keeps the vault. |
| `legacy-writer` | An in-place edit by an old desktop build (0.17) is absorbed with no conflict and leaves no side files. |
| `file-safety` | Across the whole suite no `-wal`, `-shm` or `-journal` file appears in the cloud folder; every vault file has SQLite header bytes 18/19 = 2/2 (WAL) and opens the way iOS 1.0.5 opens it. Run alone it only covers its own vault, so judge it from a full suite run. |

## Prerequisites (the harness checks or fixes these itself)

- macOS or Linux, Node 20+, Docker running (preflight fails fast with the fix otherwise).
- Local Appwrite at localhost:8085, project `conduit-dev`, made once with `npm run appwrite:setup`
  (`docs/LOCAL_APPWRITE.md`). The harness reads `conduit-dev.env` in the stack folder, refuses any
  endpoint that is not localhost, and starts the stack (`docker compose up -d`) when it is down.
- When anything under `appwrite/` changed since the last deploy (stamp file `.deployed-conduit-dev`),
  it redeploys the schema, the seed rows (tiers, `app_config`) and the `api` function. There is no
  SQL, no dump and no schema check: the rules come from `appwrite/src/api/` in this checkout.
- Isolation: its own Vite on a free port (never 1420); each device in `/tmp/cv-<id>/<name>/` with its
  own HOME, app data, Chromium profile and MCP socket, `--use-mock-keychain`, no `conduit://` or global
  shortcut registration. Test users are `verify-<runId>-<n>@conduit.local`.

## Run it

```bash
npm run verify:sync
node scripts/verify/run.mjs sync --only take-back                       # one scenario
node scripts/verify/run.mjs sync --only free-takeover-server --only take-back
node scripts/verify/run.mjs sync --only legacy-writer --keep            # keep /tmp/cv-<id> to inspect
```

`take-back` needs nothing from `free-takeover-server`; every scenario sets up its own devices. Exit
code 0 means all passed including cleanup, 1 means a failure, 2 means bad arguments. Test windows
appear on screen: leave them alone.

## How long

About 75 seconds (setup about 8 s, scenarios about 65 s). Use a 10 minute timeout. A cold Appwrite
start, or a redeploy after `appwrite/` changed, can add a few minutes.

## Read the results

The output ends with a table and `RESULT: PASS|FAIL in <time>  (.verify/<runId>/results.json)`.
In `.verify/<runId>/`:

- `results.json`: `phases[]`, `scenarios[]` (`status`, timestamped `steps` such as "A displaced after
  0.7 s", `error`, `failure[]` with per device screenshot and log tails), `cleanup`.
- `shots/`: numbered PNGs of each step; `<n>-<device>-FAIL-sync-<scenario>.png` on failure.
- `logs/`: `run.log`, `<device>.main.log` (sync engine and lease messages), `<device>.renderer.log`,
  `cleanup.log`.
- Lease rows, from the repo root (read-only, as the service):
  `node --input-type=module -e "import {rows} from './scripts/verify/lib/backend.mjs'; console.table(await rows('personal_vault_sessions', {}, {columns: 'device_name, status, displaced_reason'}))"`,
  or table `personal_vault_sessions` in the console (http://localhost:8085). Only useful while a run
  is going: test users and their lease rows are deleted at cleanup, even with `--keep`.
- `/tmp/cv-<id>`: `<id>` is the last six characters of the run id (run `20260926-164231-09e7a5` uses
  `/tmp/cv-09e7a5`); after `--keep`, `results.json` `cleanup.keptRoots` holds the exact path.

## When something fails

1. Read the failing scenario's `steps`, `error`, screenshot and `<device>.main.log`. Decide: app bug,
   harness bug or environment (see Troubleshooting).
2. Re-run only it: `node scripts/verify/run.mjs sync --only <scenario>` (add `--keep` to inspect).
3. Fix the root cause in the app or the harness and add a unit test where the code allows.
4. Never make it pass by weakening an assertion, removing a check, skipping a scenario or raising a
   timeout without a measured reason. If a check disagrees with `docs/MULTI_DEVICE_SYNC.md`, say so
   and cite the section.
5. A scenario that passes only sometimes is a real race: report it.
6. Finish with the full `npm run verify:sync`. Run every suite (`npm run verify`) only when the user
   asks for it or for a release candidate.

Known wording: after a take-over the locked-out modal is titled "Opened on <device>"; "Vault locked"
is used for plan-limit and owner-claim cases. All test devices share this machine's name.

## Cleanup guarantees

On pass, fail or Ctrl+C (once; twice aborts cleanup) the run quits every device, stops its Vite,
deletes its test users (their leases cascade), removes `/tmp/cv-<id>/` and
`.verify/<runId>/dist-electron/`, then kills and reports any process still mentioning the run; any
leftover makes the run FAIL. Stale `verify-*` users older than 6 hours are deleted at the start, and
`.verify/` is pruned to the 20 newest run folders before the new one is made (21 after a run). Local
Appwrite keeps running. `--keep` keeps only the device roots and `dist-electron/` (test users are
still deleted); afterwards delete `/tmp/cv-<id>` and `.verify/<runId>/dist-electron` yourself.

Quick check afterwards: `find /tmp/ -maxdepth 1 -name 'cv-*'` (the trailing slash matters on macOS,
where `/tmp` is a symlink) and `ps ax | grep -F /tmp/cv- | grep -v grep` both print nothing, unless
another run is going.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Docker is not running` | Docker Desktop is off | Start it, wait for `docker info`, rerun. |
| appwrite phase fails or the API does not answer | Stack never set up, half-started, or short of memory | If the message names a missing `conduit-dev.env`, run `npm run appwrite:setup`. Check `curl -s http://localhost:8085/v1/health/version` and `docker ps --filter name=appwrite`; run `npm run appwrite:stop` and rerun (the harness starts it again). Give Docker Desktop at least 4 GB of memory. |
| `appwrite deploy` fails in the appwrite phase | Build or schema error in `appwrite/` | `npm run test:server`, then `npm run appwrite:deploy` to see the error; fix the code, not the check. Deployment and execution logs are in the console (http://localhost:8085). |
| Port 8085 busy | Another Appwrite stack | `lsof -nP -iTCP:8085 -sTCP:LISTEN`; ask the user before stopping it. |
| Page call timeout or a macOS keychain prompt | A code path reached the real keychain | Never answer it. Let cleanup kill the device or SIGKILL only that device's pid; fix the isolation in `scripts/verify/lib/launcher.mjs`. |
| `EINVAL` on the MCP socket or `too long for the MCP socket path` | Socket path over 104 bytes | Device names 1 to 12 characters, roots stay at `/tmp/cv-<id>/<name>`. |
| `Device name "<name>" was already used by <suite>/<scenario>` | Two scenarios, often in different suites, launch the same name; a device root lasts the whole run | Rename the newer scenario's devices with its suite's prefix (backup `b`, copies `c`, lifecycle `l`, mcp `m`, password `p`, resilience `r`, sync `s`). |
| `createVault: <path> already exists` | Two scenarios use the same `<cloud>/<folder>/` | Name the folder with the suite's prefix, like its devices. |
| A displaced check fails with only "Saving your last changes..." as the text | The spec 6.6 step 1 overlay was read before the soft-lock modal replaced it | Use `waitForDisplaced` from `lib/sync-flows.mjs`, which waits the overlay out; if the overlay never goes away, that is an app bug (the final sync is capped at 15 s). |
| Unlock dialog shows the normal prompt instead of the take-over text | Renderer state cleared by React StrictMode's dev double mount | Look for state cleared in an unmount cleanup (see `src/components/sync/useForgetUnlockRequest.ts`). |
| Dependencies missing | Install step skipped | `npm install`, `(cd mcp && npm install)`. |
| `[cleanup] FAIL` or `leftover process killed` | A device did not quit | Read `logs/cleanup.log`; fix the quit path. |

## Safety rules

- Only the local stack on localhost; never production Appwrite (`appwrite.cloudwise.ca`) or any cloud
  project; never `CONDUIT_ENV=production`.
- Never touch the user's dev profile (`~/Library/Application Support/conduit/conduit-dev`, "Conduit
  Dev"), their running dev app or port 1420, or `~/.claude.json`.
- Never answer a macOS keychain prompt; only kill processes that belong to the run.
- Never run `docker compose down -v` on the local stack or delete its env file unless the user asks;
  never print the API key, the service secret or tokens.

## Report back

One line with the result and time, then passed / total, then each failure with its root cause and
the fix or open question, and the run folder. Quote the `RESULT:` line as printed; never claim a pass
you did not run.
