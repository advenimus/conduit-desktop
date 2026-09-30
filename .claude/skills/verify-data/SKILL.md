---
name: verify-data
description: Run the live vault data suites (password changes, vault lifecycle, copies of a vault, local and cloud backups, offline and team resilience) against the real Conduit app and a local Supabase. Use after changing master-password or key epochs, Recently deleted or redaction, rename and file binding, the separate-vault fork, damaged-copy recovery, the idle lock, the Sync settings tab, conflict or user copies, side files, snapshots and undo, local or cloud backup and restore, offline leases, the cached tier, team vaults beside personal sync, or export and import, or when asked to verify any of these live. Each suite also runs alone. Fully isolated; about 10 minutes for all five.
---

# /verify-data: vault data suites

Runs `npm run verify:data` (`node scripts/verify/run.mjs backup copies lifecycle password resilience`).
Real Electron devices share the run's "cloud" folder, sign in as generated test users on a local
Supabase and are driven like a user. The spec under test is `docs/MULTI_DEVICE_SYNC.md`; the harness
reference is `scripts/verify/README.md`. Every suite at once is the `verify` skill; the sync engine's
core loop (take-over, merge, conflicts, plan changes) is the `verify-sync` skill.

Pick the suite that covers what you changed and run it alone. Run all five only when your change
spans several of them or the user asks for it:

| Suite | Run it alone | About | Covers |
|---|---|---|---|
| `password` | `node scripts/verify/run.mjs password` | 1 min | Master-password change on a synced vault (4.7, 4.8): the "Syncing paused" prompt, old and new passwords, erasing Recently deleted with the change. |
| `lifecycle` | `node scripts/verify/run.mjs lifecycle` | 3 min | Recently deleted and "Delete permanently" (4.7), rename and the other device's rebind (5.9), separate vault, damaged working copy, idle auto-lock, Settings > Sync. |
| `copies` | `node scripts/verify/run.mjs copies` | 2 min | Cloud conflict copies, user copies, older-desktop side files, mass-change snapshot and undo, two devices on two copies (5.5, 5.8, 5.10). |
| `backup` | `node scripts/verify/run.mjs backup` | 2 min | Local backup, rollback and restore as a new vault, cloud backup plan gate and downgrade (5.10, 8.1, 8.2). |
| `resilience` | `node scripts/verify/run.mjs resilience` | 2.5 min | Offline open and reconnect, a take-over learned on reconnect, the cached Pro tier, team vaults beside personal sync, export and import (4.2, 6.5 to 6.8). |

## What it proves

Every scenario uses its own devices and its own folder `<cloud>/<scenario>/`.

### password

| Scenario | In plain words |
|---|---|
| `change-while-both-open` | On Pro, A changes the password (Vault > Change Password...). The shared file then has two key epochs with the old salt and verifier erased. B shows "Syncing paused" naming A, presses [Later] and keeps editing a host and a secret, which are not published. The old password is refused with "That is an older password. Enter the newest one."; the new one publishes B's edits to A, both show the same entries and every secret decrypts. After a lock the old password gets "Invalid master password" on both devices and the new one unlocks. |
| `change-while-other-closed` | B is killed right after an edit, so the edit is unpublished. A changes the password and edits again. B's old password opens only B's own copy and pauses syncing (spec 4.8 unlock policy); after a lock the new password merges both edits on both devices and B's secret decrypts on A. |
| `erase-recently-deleted` | The change with "Also permanently delete items in Recently deleted" ticked redacts the deleted login in the shared file; after B enters the new password both devices list one untitled "Erased permanently" row and nothing can be restored. |
| `older-file-old-password` | When the pre-change shared file comes back, the old password gets "Master password changed" naming the device; the new password there unlocks and republishes under the new key. |

Each password scenario also checks the shared file: WAL header 2/2, the iOS 1.0.5 open, and no
`-wal`, `-shm` or `-journal` file.

### lifecycle

| Scenario | In plain words |
|---|---|
| `recently-deleted` | On Pro, an entry with a password and a history row deleted on A shows in Recently deleted on A and B. [Restore] on B brings it back on both with its password. Deleted again and erased with "Delete permanently" on A, it leaves both lists (an "Erased permanently" record stays); the shared file's grave has `row_json` NULL and `redacted = 1`, every register is redacted, and no name, host, username, notes or password cipher (current or old) is left in the file's bytes. |
| `rename-and-rebind` | A renames the vault with File > Rename Vault... and keeps working at the new path. About 33 s later B shows "Found the vault file under its new name." with [Undo], follows the new path (sync state, `vault_get_path`, recent vaults), both keep syncing and nothing recreates the old file. After a relaunch B's hub offers only the renamed file and opens it. |
| `make-separate-vault` | Opening a copy of a synced vault on the same device offers "'Vault.conduit' is a copy of ...". [Use as a separate vault] writes a new file with a new lineage, genesis and vault id; [Open it] opens it with the same password. Its edits never reach the original, which stays byte-for-byte the same. |
| `damaged-working-copy` | A's working copy is corrupted while A is closed and B adds an entry. At unlock A shows "This computer's copy is damaged"; [Rebuild from shared file] opens the vault with the shared file's data, parks the damaged copy byte for byte, and A syncs again. |
| `idle-auto-lock` | "Lock the vault when idle" persists in Settings, settings.json and across a relaunch. With the system idle time stubbed in the main process, 299 s idle keeps the vault open, 300 s locks it at the next 30 s check and releases the lease; the OS screen lock locks at once; with the setting Off it does nothing. |
| `settings-sync-tab` | Settings > Sync shows "one device at a time" (limit 1) for Free and "any number of devices at once" (limit -1) for Pro, and the devices list ("(this device)", "Open now"); the other device turns "Closed" after it quits. |

### copies

| Scenario | In plain words |
|---|---|
| `provider-conflict-copy` | On Pro, a third device's edit lands next to the shared file as "Vault (conflicted copy ...).conduit". A merges it within a second with the toast "Merged changes from a copy Dropbox made." and publishes it; the copy stays in place byte for byte, and B, opening later, has the edit and lists the copy as "Nothing new" with [Move to Trash]. |
| `user-copy-review` | "Vault 2.conduit" edited by desktop 0.17 (3 deletes, 1 host change) shows "... 4 changes that aren't in your vault, including 3 deletions." and is never merged on its own. [Ignore this copy] and [Don't merge] change nothing on A, B or the shared file. [Merge] applies the edit and the deletions, except an item B changed while the preview was open, which becomes one "Deleted and edited" review item ([Keep item] keeps it). |
| `side-files-pause` | `-wal` and `-shm` next to the shared file show the side-files banner on both devices. A's new entry and edit stay on A for 10 s (a normal publish takes about 2 s) while the status is paused. [Conduit is closed on my other computers] moves both files into A's `sidefiles-<ts>/` folder (not deleted), publishing resumes within 5 s (measured 0.3 s) and B gets the held edits. |
| `mass-delete-undo` | On Pro, A deletes a folder with 12 entries. B applies it, takes one pre-merge snapshot and shows "A sync from another device deleted or changed 13 items." (the folder counts too). Undo lists exactly those 13 rows; "Undid 13 changes." restores them on both devices and keeps a later unrelated edit and an earlier single delete. |
| `different-copies` | On Pro, A syncs `.../Dropbox/Vault.conduit` and B a copy at `.../OneDrive/Vault.conduit` (same lineage). Both get "Two copies of this vault" (B at unlock, A about 15 s later from B's session row); [Merge them...] on each device previews one change and merges it, so both copies hold both edits. |

### backup

| Scenario | In plain words |
|---|---|
| `local-backup-rollback` | On Free, Settings > Backup turns local backup on; edits make a backup about 5 s later, a WAL-header SQLite file with no free pages, this vault's lineage and nothing left next to it. "Restore from backup" lists the deleted entry and "1 newer value will be replaced"; [Roll this vault back] brings the entry and the old password back, keeps the replaced one in password history as "rollback", matches the backup and is published. With the shared folder read-only a backup still holds an entry only the working copy has. |
| `rollback-syncs` | The same rollback on Pro device A reaches device B (entry, password and the "rollback" history row) about 2.5 s later. |
| `restore-as-new-vault` | [Restore as a new vault...] writes a file with the backup's entries, a new lineage and a WAL header without writing the original; [Open it] opens it with the same password; the original keeps its lineage, vault id, entries and history. |
| `cloud-backup-plan-gate` | On Free the Cloud Backup toggle is disabled with a "Pro and Team" badge, the enable and restore IPC calls are refused with the plan messages, and the `vaults` bucket stays empty. On Pro an upload lands under `<user id>/<vault id>/`, `cloud_backup_list` shows it, and a Backup Manager restore goes through the preview and brings a deleted entry back. Downgraded while open, the toggle is refused with the toast "Could not change cloud backup: Cloud backup needs the Pro or Team plan.". |
| `downgraded-backup-stops` | A Pro edit reaches the bucket about 5 s later; after lock, downgrade to Free and unlock, an edit uploads nothing for 15 s and cloud backup shows off. |

### resilience

| Scenario | In plain words |
|---|---|
| `offline-open` | On Free, with the device's Supabase link cut after sign-in, a vault is created, locked and opened again; Settings > Sync shows "Offline: device check paused", the limit stays 1, edits reach the shared file and the server has no lease row. When the link returns an active lease row appears with no user action (about 60 s, the offline retry) and the badge clears. |
| `offline-takeover-reconnect` | On Free, A's link is cut after its offline edits publish; B (its own drive folder, fed A's file) takes over because the server still sees A, and has A's edits. A keeps working until its link returns; about 30 s later it shows "Opened on ..." with "Your changes from this device were saved.", soft-locks, and its file keeps every edit, including one made after the take-over. |
| `cached-pro-offline` | Pro devices sign in once online, then relaunch with Supabase cut (cached auth mode) while a signed-out device holds the owner claim. An 8-day-old cache and one dated a day ahead get the one-device take-over dialog (limit 1, source `default`); the normal cache opens with no prompt (limit -1, source `tier-cache`) and its edit reaches the online device, the only one with a server lease. |
| `team-vault-regression` | A Team user's team vault syncs from A to B (identity key recovered with the passphrase) through `vault_entries`, with no personal-sync lineage folder, sync lineage, running personal sync or `personal_vault_sessions` row for it; after "Lock Current Vault" the personal vault's edits sync both ways. |
| `import-export` | An export of a folder and 3 entries is read by the preview (a wrong passphrase fails). Imported into a vault with an open same-field conflict on both devices, the entries arrive with new ids, the folder, the remapped credential and their secrets, sync to the other device, and the conflict stays open with both values. |

## Prerequisites (the harness checks or fixes these itself)

- macOS or Linux, Node 20+, Docker running, psql (preflight fails fast with the fix otherwise).
- Local Supabase on 127.0.0.1:54321 (API) and :54322 (DB). A running stack with project_id `conduit`
  is reused; otherwise the harness starts one with the pinned CLI
  `npx -y supabase@2.109.1 start --workdir ~/.cache/conduit-verify/supabase` (`SUPABASE_CLI`
  overrides; a Homebrew `supabase` binary can be broken, so it is not used).
- If `public.tiers` is missing it restores the newest `~/conduit-backups/conduit-preview-*.sql`. It
  applies `20260501000000_add_parent_entry_id.sql` and every migration dated `20260926000000` or later on every run, then
  `scripts/verify/sql/local-parity.sql`, which these suites need: the private `vaults` storage bucket
  and its four `storage.objects` policies (backup), the 23-argument `upsert_vault_entry_versioned`
  and the team RLS helper and `get_team_members_with_email` grants (resilience's team vault). The
  supabase phase fails with the missing object if any check does not hold.
- Offline scenarios use the per-device TCP proxy in `lib/net-proxy.mjs` (`ctx.supabaseProxy()`), fed
  to the device as `CONDUIT_DEV_SUPABASE_URL`. The app honors it only in unpackaged preview builds
  and only for a loopback URL, so the shared stack keeps serving every other device and run.
- The backup suite's local restore opens the app's own "Restore from backup" dialog through a
  dynamic `import()` from the run's Vite dev server (the app has no local-restore screen), so it
  needs the dev renderer the harness always uses.
- Isolation: its own Vite on a free port (never 1420); each device in `/tmp/cv-<id>/<name>/` with its
  own HOME, app data, Chromium profile and MCP socket, `--use-mock-keychain`, no `conduit://` or
  global shortcut registration. Test users are `verify-<runId>-<n>@conduit.local`; teams they own are
  removed with them.

## Run it

```bash
npm run verify:data                                             # all five suites
node scripts/verify/run.mjs copies                              # one suite
node scripts/verify/run.mjs lifecycle --only rename-and-rebind  # one scenario (repeat --only for more)
node scripts/verify/run.mjs backup --only downgraded-backup-stops --keep   # keep /tmp/cv-<id> to inspect
```

Suites run in file-name order (backup, copies, lifecycle, password, resilience) whatever order you
name them in. Exit code 0 means all passed including cleanup, 1 means a failure, 2 means bad
arguments. Test windows appear on screen: leave them alone.

## How long

About 10 minutes for all five (setup about 8 s; scenario time in a full run: backup 113 s, copies
105 to 145 s, lifecycle 160 s, password 50 s, resilience 148 s). Alone, each suite takes its
scenario time plus about 15 s.
Most of the time is the app's own waits, which a test cannot shorten: the 30 s missing-file debounce
before a rebind (5.9), the idle lock's 30 s check, the 30 s heartbeat and 60 s offline retry (6.2),
the 5 s backup debounce, and fixed 6 to 15 s windows that prove nothing is published or uploaded.
Use a 20 minute timeout for all five (run it in the background if your tool caps a command at 10
minutes) and 10 minutes for one suite.

## Read the results

The output ends with a table and `RESULT: PASS|FAIL in <time>  (.verify/<runId>/results.json)`.
In `.verify/<runId>/`:

- `results.json`: `phases[]`, `scenarios[]` (`status`, timestamped `steps` such as "A merged it
  within 0.5 s", `error`, `failure[]` with per device screenshot and log tails), `cleanup`.
- `shots/`: numbered PNGs of each step; `<n>-<device>-FAIL-<suite>-<scenario>.png` on failure.
- `logs/`: `run.log`, `<device>.main.log` (sync engine, file binding, lease, backup messages),
  `<device>.renderer.log`, `supabase-*.log`, `cleanup.log`.
- `/tmp/cv-<id>`: `<id>` is the last six characters of the run id; after `--keep`, `results.json`
  `cleanup.keptRoots` holds the exact path.

Passed / total and time per suite of the newest run are printed by the command in the `verify`
skill's "Read the results".

## When something fails

1. Read the failing scenario's `steps`, `error`, screenshot and `<device>.main.log`. Decide: app bug,
   harness bug or environment (see Troubleshooting).
2. Re-run only it: `node scripts/verify/run.mjs <suite> --only <scenario>` (add `--keep` to inspect).
3. Fix the root cause in the app or the harness and add a unit test where the code allows.
4. Never make it pass by weakening an assertion, removing a check, skipping a scenario or raising a
   timeout without a measured reason. If a check disagrees with `docs/MULTI_DEVICE_SYNC.md`, say so
   and cite the section.
5. A scenario that passes only sometimes is a real race: report it. Timings are noisier when other
   live runs share the machine; the final word is a run with nothing else going.
6. Finish by re-running the suite you fixed. Run every suite (`npm run verify`) only when the user
   asks for it or for a release candidate.

Suite-specific hints:

| Symptom | Where to look |
|---|---|
| password: the old password gets "Invalid master password" where a check expects "Master password changed" | By design once the change is published: 4.8 erases the old verifier, so the app cannot tell an old password from a typo. Only a file from before the change (`older-file-old-password`) shows the dialog. Spec 12 row 59 words it differently; that conflict is open for the owner. |
| password: B's edit is already in the shared file before the change | B was quit, not killed: a normal quit's final sync publishes. The suite kills B within the 2 s publish delay. |
| lifecycle: no rebind toast within 75 s on B | `l2b.main.log` for `file binding:` lines. A "Vault file not found" banner instead means `resolveMissing` did not find exactly one same-lineage synced file with a normal name (`electron/services/sync/file-binding.ts`). |
| lifecycle: B rebinds but its path, settings or relaunched hub still name the old file | The app no longer follows the binding: `electron/services/sync/app-sync-binding.ts`, `AppSyncManager.followBinding`, `AppState.followSharedFile`, and the renderer's `vault:path-changed` listener in `src/components/sync/useSyncEvents.ts`. |
| lifecycle: values still found in the shared file after "Delete permanently" | `electron/services/sync/tombstones.ts` (`deletePermanently`) and the publish (VACUUM INTO) in `shared-file-publish.ts`. |
| lifecycle: the idle lock never locks | `idleChecks` stays 0: the setting is not on in the main process (`vault_idle_lock_minutes`) or the vault is not a personal one. `ipc/vault-idle.ts` reads `powerMonitor.getSystemIdleTime`; the stub counts only its reads. The Settings menu offers 5, 15, 30 and 60 minutes and shows any other stored value as "Custom (N min)". |
| copies: no "Two copies of this vault" in `different-copies` | The prompt needs a different `file_id` or provider kind (`electron/services/sync/divergence.ts`). A byte copy keeps the `file_id`, so the copies must sit in folders named `Dropbox` and `OneDrive`; two plain folders only trigger the 24-hour rule. |
| copies: the "Undid N changes." count looks too high | Undo counts restored items plus restored fields, not low-level writes (`countUndone` in `electron/services/sync/snapshots-undo.ts`). A folder delete counts the folder too (13 for 12 entries). |
| copies: `side-files-pause` "publishing resumed" times out, with "A status right after the confirmation: paused (side-files)" | The confirmation no longer covers the other device's server flag: `SideFiles.confirm` must record `sideFilesConfirmedAtMs` in local.json and `uncoveredSideFilesFlag` (`electron/services/vault-session/session-runtime-parts.ts`) must skip rows last active at or before it (server clock via `LeaseTracker.toServerMs`). A cycle when the flag clears comes from `PersonalVaultRuntime.onSessionsRefreshed`. |
| copies: the preview sections are empty | `candidatePreview` in `lib/sync-panels.mjs` matches section titles by prefix; a title with a note in brackets still counts. |
| backup: a second cloud upload has no snapshot of its own | "The resource already exists" in the main log means two snapshots got one name: `snapshotFileName` in `electron/services/vault/cloud-backup-name.ts` must add milliseconds and a random tag. |
| backup: a downgraded account still uploads | Cloud backup must re-read the plan (`authService.reloadProfile()`) before each upload, on enable, on restore and after unlock (`electron/services/vault/cloud-sync.ts`, `electron/ipc/cloud-sync.ts`). |
| resilience: the offline badge takes up to 30 s | Expected: a running device turns unconfirmed at its next failed heartbeat (30 s), or within about 3 s when an edit publishes. A device that opened offline gets its lease at the next 60 s retry. |
| resilience: the offline device is displaced before its link returns | Both devices were in one folder: the other device's owner claim displaces a Free device whose lease is unconfirmed (6.7). Give each device its own `Drive` folder and hand files over with `deliverFile` (`lib/offline-flows.mjs`). |
| Any: "1 AI task" in a take-over or displaced dialog of an idle device | An agent terminal counts only after input and while input or output came in the last 2 minutes (`agentTerminalActive` in `electron/services/terminal/manager.ts`), and a chat session only while a turn runs (`EngineManager.runningTurns`); the sum feeds `busy.agentJobs` in `electron/services/state.ts`. |

## Cleanup guarantees

On pass, fail or Ctrl+C (once; twice aborts cleanup) the run quits every device, closes every
Supabase proxy, stops its Vite, deletes its test users (their leases go with them), their cloud
backups in the `vaults` bucket and the teams they own, removes `/tmp/cv-<id>/` and
`.verify/<runId>/dist-electron/`, then kills and reports any process still mentioning the run; any
leftover makes the run FAIL. Stale `verify-*` users older than 6 hours are deleted at the start, and
`.verify/` is pruned to the 20 newest run folders before the new one is made (21 after a run). Local
Supabase keeps running. `--keep` keeps only the device roots and `dist-electron/` (test users are
still deleted); afterwards delete `/tmp/cv-<id>` and `.verify/<runId>/dist-electron` yourself.

Quick check afterwards: `find /tmp/ -maxdepth 1 -name 'cv-*'` (the trailing slash matters on macOS,
where `/tmp` is a symlink) and `ps ax | grep -F /tmp/cv- | grep -v grep` both print nothing, unless
another run is going.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Docker is not running` | Docker Desktop is off | Start it, wait for `docker info`, rerun. |
| supabase phase fails or the API does not answer | Broken Homebrew CLI or a half-started stack | Keep the pinned `npx` CLI. Check `curl -s http://127.0.0.1:54321/auth/v1/health` and `docker ps --filter name=supabase_`; if unhealthy, `npx -y supabase@2.109.1 stop --workdir ~/.cache/conduit-verify/supabase` and rerun. See `logs/supabase-start.log`. |
| `Local Supabase schema check failed` naming the bucket, a policy, the 23-argument RPC or a team helper | `local-parity.sql` did not apply | Read `logs/supabase-migrate.log`; fix `scripts/verify/sql/local-parity.sql` or the migration, not the check. |
| `public.tiers is missing and no ~/conduit-backups/conduit-preview-*.sql backup exists` | Fresh database, no dump | Ask the user for a preview backup in `~/conduit-backups/` (`docs/LOCAL_SUPABASE.md`). Never create one from production. |
| Ports 54321 or 54322 busy | Another Supabase project | `lsof -nP -iTCP:54321 -sTCP:LISTEN`; ask the user before stopping it. |
| Page call timeout or a macOS keychain prompt | A code path reached the real keychain | Never answer it. Let cleanup kill the device or SIGKILL only that device's pid; fix the isolation in `scripts/verify/lib/launcher.mjs`. |
| `Device name "<name>" was already used by <suite>/<scenario>` | Two scenarios, often in different suites, launch the same name; a device root lasts the whole run | Rename the newer scenario's devices with its suite's prefix (backup `b`, copies `c`, lifecycle `l`, mcp `m`, password `p`, resilience `r`, sync `s`). |
| `createVault: <path> already exists` | Two scenarios use the same `<cloud>/<folder>/` | Name the folder with the suite's prefix, like its devices. |
| Test windows reload mid-run | Someone edited `src/` while the run's Vite served it (hot reload) | Rerun with nobody editing the renderer. |
| Dependencies or `psql` missing | Install step skipped | `npm install`, `(cd mcp && npm install)`, `brew install libpq` or `PSQL=/path/to/psql`. |
| `[cleanup] FAIL` or `leftover process killed` | A device did not quit | Read `logs/cleanup.log`; fix the quit path. |

## Safety rules

- Only the local stack on 127.0.0.1; never production Supabase or any cloud project; never
  `CONDUIT_ENV=production`. The offline proxy only forwards to 127.0.0.1:54321.
- Never touch the user's dev profile (`~/Library/Application Support/conduit/conduit-dev`, "Conduit
  Dev"), their running dev app or port 1420, or `~/.claude.json`.
- Never answer a macOS keychain prompt; only kill processes that belong to the run.
- Never run `supabase db reset`; never print the service-role key or tokens.

## Report back

One line with the result and time, then one line per suite (passed / total and time), then each
failure with its root cause and the fix or open question, and the run folder. Quote the `RESULT:`
line as printed; never claim a pass you did not run.
