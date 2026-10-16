---
name: verify-mcp
description: Run only the live MCP suite (tool list, no daily quota, MCP writes that sync to a second device, has_conflict, locked and open_elsewhere errors, two agents side by side, audit log) against the real Conduit app, its MCP server and a local Appwrite. Use after changing mcp/src/, electron/ipc-server/, the MCP gatekeeper, agent session ownership, tier or quota handling, or vault lock errors, or when asked to verify MCP live. Fully isolated; takes about 1 minute.
---

# /verify-mcp: MCP suite

Runs `npm run verify:mcp` (`node scripts/verify/run.mjs mcp`). Real Electron devices unlock vaults on
a local Appwrite, and a real MCP client (the built `mcp/dist` server over stdio) connects to each
device's own socket. The harness reference is `scripts/verify/README.md`. Every suite at once is the
`verify` skill.

## What it proves

| Scenario | In plain words |
|---|---|
| `tools-list` | A Free user with an unlocked vault: tools/list has the vault tools (`entry_list`, `entry_info`, `entry_search`, `entry_update_notes`, `entry_edit_notes`, `document_create`, `document_update`, `credential_list`) and `entry_list` works. |
| `no-daily-quota` | A Free user makes 60 tool calls (the old daily cap was 50), spaced under the per-minute rate limit; none is refused and no `mcp-quota.json` exists in the device's HOME, app data or the cloud folder. |
| `writes-sync` | On Pro, `entry_update_notes` (its `!!secret!!` is encrypted into a hidden secret and a ref), `entry_edit_notes` (a one-line edit that keeps the ref), `document_create` and `document_update` show on the device (IPC and the entry tree) and reach a second device, the encrypted secret included. |
| `notes-secrets` | The app encrypts `!!secret!!` into refs on save; MCP reads show refs, never values; edits keep refs, add new secrets encrypted, and refuse bad writes; a dropped ref leaves its secret flagged unused; documents do the same. An agent types a secret into a shell by ref and reads back only the ref; page scripts refuse refs. `credential_read` returns refs, and `reveal` waits for the reveal dialog (Deny refuses, Allow once returns the value). The entry page shows chips by name. |
| `has-conflict` | A same-field edit on two Pro devices makes `entry_info` return `has_conflict: true`; after it is resolved in the review panel it is false on both devices. |
| `locked-and-elsewhere` | A manually locked vault returns `code: VAULT_LOCKED` with no reason; after a Free take-over from another device it returns `reason: open_elsewhere` and the device shows the locked-out dialog. |
| `two-agents` | Two MCP clients on one device are two agents. Each runs commands in its own local shell; the other is refused with `SESSION_IN_USE` in it but can still read it; `connection_list` shows `owner` you, other_agent and free (a shell the user opened); once agent A's MCP process exits, B can use A's old shell. |
| `knowledge` | `entry_info` suggests moving heading-structured notes; `kb_import_notes` makes articles and keeps the notes; folder and tag-matched vault articles reach the asset in contract order; `kb_write` edits flag the article for review with reasons in its history; `kb_log`, `kb_verify` and `kb_search` work; articles stay out of `entry_list` and the renderer's lists and are deleted with their asset. |
| `knowledge-sync` | On Pro, an article and its encrypted secret reach a second device; the same article edited on both at once shows one conflict (the text) in the review panel, the metadata and history settle themselves, and both devices end with the same article and a merged history. |
| `knowledge-team` | In a team vault, an asset with a secret chip and an article upload to the server with no value in plain text; a second team member added as editor opens the vault, finds the article under its asset, decrypts the chip and lists only the asset. |
| `audit` | Every MCP call of the run is in `<HOME>/.config/conduit/audit.log` in order with the right outcome, an `api_key` argument is logged as `[REDACTED]`, and failed calls are logged as errors. It also passes alone (`--only audit`). |

## Prerequisites (the harness checks or fixes these itself)

- macOS or Linux, Node 20+, Docker running, `mcp/` dependencies installed (preflight fails fast with
  the fix otherwise). The build phase compiles `mcp/` into `mcp/dist` each run.
- Local Appwrite at localhost:8085, project `conduit-dev`, made once with `npm run appwrite:setup`
  (`docs/LOCAL_APPWRITE.md`). The harness reads `conduit-dev.env` in the stack folder, refuses any
  endpoint that is not localhost, and starts the stack (`docker compose up -d`) when it is down.
- When anything under `appwrite/` changed since the last deploy (stamp file `.deployed-conduit-dev`),
  it redeploys the schema, the seed rows (tiers, `app_config`) and the `api` function. There is no
  SQL, no dump and no schema check: the rules come from `appwrite/src/api/` in this checkout.
  The seed tiers keep `mcp_daily_quota=-1` and Free `vault_max_open_devices=1`.
- Isolation: its own Vite on a free port (never 1420); each device in `/tmp/cv-<id>/<name>/` with its
  own HOME (so its own audit log), app data, Chromium profile and MCP socket, `--use-mock-keychain`.
  The MCP client never touches `~/.claude.json` or the user's MCP config. Test users are
  `verify-<runId>-<n>@conduit.local`.

## Run it

```bash
npm run verify:mcp
node scripts/verify/run.mjs mcp --only locked-and-elsewhere            # one scenario
node scripts/verify/run.mjs mcp --only tools-list --only audit
node scripts/verify/run.mjs mcp --only audit --keep                    # keep /tmp/cv-<id> to read the audit logs
```

Exit code 0 means all passed including cleanup, 1 means a failure, 2 means bad arguments. Test
windows appear on screen: leave them alone.

## How long

About 1 minute (setup about 8 s, scenarios about 47 s; `no-daily-quota` alone is about 17 s because
its calls are spaced for the rate limiter). Use a 10 minute timeout. A cold Appwrite start, or a redeploy
after `appwrite/` changed, can add a few minutes.

## Read the results

The output ends with a table and `RESULT: PASS|FAIL in <time>  (.verify/<runId>/results.json)`.
In `.verify/<runId>/`:

- `results.json`: `phases[]`, `scenarios[]` (`status`, timestamped `steps`, `error`, `failure[]` with
  per device screenshot and log tails), `cleanup`.
- `logs/<device>.mcp.log`: the MCP server's stderr for that device; `<device>.main.log` shows the
  app side (IPC server, gatekeeper, vault guard).
- `shots/`: numbered PNGs; `<n>-<device>-FAIL-mcp-<scenario>.png` on failure.
- A tool error body looks like
  `{"error":"VAULT_LOCKED: ...","code":"VAULT_LOCKED","reason":"open_elsewhere"}`
  (built in `mcp/src/tool-error.ts`).
- `/tmp/cv-<id>`: `<id>` is the last six characters of the run id (run `20260926-164136-eebd6b` uses
  `/tmp/cv-eebd6b`); after `--keep`, `results.json` `cleanup.keptRoots` holds the exact path.

## When something fails

1. Read the failing scenario's `steps`, `error`, `<device>.mcp.log` and `<device>.main.log`. Decide:
   app bug, harness bug or environment (see Troubleshooting).
2. Re-run only it: `node scripts/verify/run.mjs mcp --only <scenario>` (add `--keep` to read
   `/tmp/cv-<id>/<device>/home/.config/conduit/audit.log`).
3. Fix the root cause and add a unit test (`mcp/src/__tests__/`, `electron/ipc-server/__tests__/`)
   where the code allows.
4. Never make it pass by weakening an assertion, removing a check, skipping a scenario, lowering the
   call count or raising a timeout without a measured reason.
5. A scenario that passes only sometimes is a real race: report it.
6. Finish with the full `npm run verify:mcp`. Run every suite (`npm run verify`) only when the user
   asks for it or for a release candidate.

## Cleanup guarantees

On pass, fail or Ctrl+C (once; twice aborts cleanup) the run closes every MCP client, quits every
device, stops its Vite, deletes its test users, removes `/tmp/cv-<id>/` and
`.verify/<runId>/dist-electron/`, then kills and reports any process still mentioning the run; any
leftover makes the run FAIL. Stale `verify-*` users older than 6 hours are deleted at the start, and
`.verify/` is pruned to the 20 newest run folders before the new one is made (21 after a run). Local
Appwrite keeps running. The build rewrites the gitignored `mcp/dist/`; that is expected. `--keep`
keeps only the device roots and `dist-electron/` (test users are still deleted); afterwards delete
`/tmp/cv-<id>` and `.verify/<runId>/dist-electron` yourself.

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
| `EINVAL` or `connect ENOENT` on the MCP socket, or `too long for the MCP socket path` | Socket path over 104 bytes, or the device's app is not up yet | Device names 1 to 12 characters, roots stay at `/tmp/cv-<id>/<name>`. Call `ctx.connectMcp(device)` only after `launchDevice` returns: the MCP server connects to the app once at startup and keeps saying "Not connected" if the app was not there. |
| `Rate limit exceeded` in a scenario that did not expect it | Calls faster than `mcp/src/rate-limiter.ts` allows | Space the calls; do not raise the limiter to pass. |
| Audit lines missing | The audit log is per HOME, written by the MCP process | Read the device's `home/.config/conduit/audit.log` with `--keep`; check `mcp/src/audit.ts`. |
| Page call timeout or a macOS keychain prompt | A code path reached the real keychain | Never answer it. Let cleanup kill the device or SIGKILL only that device's pid; fix the isolation in `scripts/verify/lib/launcher.mjs`. |
| Dependencies missing | Install step skipped | `npm install`, `(cd mcp && npm install)`. |
| `[cleanup] FAIL` or `leftover process killed` | A device or MCP client did not shut down | Read `logs/cleanup.log`; fix the quit path. |

## Safety rules

- Only the local stack on localhost; never production Appwrite (`appwrite.cloudwise.ca`) or any cloud
  project; never `CONDUIT_ENV=production`.
- Never touch the user's dev profile (`~/Library/Application Support/conduit/conduit-dev`, "Conduit
  Dev"), their running dev app or port 1420, `~/.claude.json`, or the Conduit MCP server registered
  in the user's own Claude Code setup. Only the MCP clients the harness starts are used.
- Never answer a macOS keychain prompt; only kill processes that belong to the run.
- Never run `docker compose down -v` on the local stack or delete its env file unless the user asks;
  never print the API key, the service secret or tokens.

## Report back

One line with the result and time, then passed / total, then each failure with its root cause and
the fix or open question, and the run folder. Quote the `RESULT:` line as printed; never claim a pass
you did not run.
