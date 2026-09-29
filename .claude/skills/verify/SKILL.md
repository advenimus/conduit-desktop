---
name: verify
description: Run every live end-to-end suite (backup, copies, lifecycle, mcp, ownership, password, resilience, smoke, sync; 50 scenarios) against the real Conduit app and a local Supabase, then summarize pass or fail. Use before shipping or after changing vault sync, device leases, vault open or lock, master passwords, backups, sign-in, tiers, or the MCP server, and whenever asked to "verify", "run the live tests" or "prove it works in the real app". Fully isolated from the user's dev app and data; takes about 12 minutes.
---

# /verify: all live suites

Runs `npm run verify`. The harness in `scripts/verify/` builds the app, launches real Electron
devices side by side, drives them like a user (and over MCP), checks the server state in the local
Supabase, and cleans up after itself. You can run it start to finish without asking the user for
anything. The harness reference is `scripts/verify/README.md`. For a narrower run use a suite skill;
they add per-scenario detail and suite-specific troubleshooting:

| Skill | Suites | Command |
|---|---|---|
| `verify-sync` (`.claude/skills/verify-sync/SKILL.md`) | `sync` | `npm run verify:sync` |
| `verify-mcp` (`.claude/skills/verify-mcp/SKILL.md`) | `mcp` | `npm run verify:mcp` |
| `verify-ownership` (`.claude/skills/verify-ownership/SKILL.md`) | `ownership` | `npm run verify:ownership` |
| `verify-data` (`.claude/skills/verify-data/SKILL.md`) | `backup`, `copies`, `lifecycle`, `password`, `resilience` | `npm run verify:data`, or `node scripts/verify/run.mjs <suite>` |

Smoke has no skill of its own (`node scripts/verify/run.mjs smoke`).

## What it proves

**smoke** (harness health)
- `two-devices`: a Free user creates a vault in the shared cloud folder; a second device in local mode shows the vault hub.
- `ipc-and-mcp`: in local mode an entry is created, renamed and deleted, and an MCP client on the device sees each change.

**sync** (personal vault sync and device limits, `docs/MULTI_DEVICE_SYNC.md`)
- `free-takeover-server`: on Free, device B opens a vault A has open, is offered a take-over, takes it and gets A's data; A is locked out and offered "Use here instead".
- `take-back`: A presses "Use here instead" and gets the vault back; B is locked out.
- `pro-merge-and-conflict`: on Pro both devices stay open; edits to different fields merge, and a same-field edit and an edit-versus-delete become conflicts that are resolved in the review panel, ending the same on both devices.
- `downgrade-and-upgrade`: Pro to Free with two devices open locks out exactly one, with the plan-limit message; back to Pro it reopens with no take-over and the other device stays open.
- `signout-releases-lease`: signing out frees the device's server lease within seconds.
- `signed-out-claims`: with nobody signed in, the owner claim inside the vault file still drives the take-over and locks A out.
- `legacy-writer`: an in-place edit by an old desktop build (0.17) is absorbed with no conflict.
- `file-safety`: no `-wal`, `-shm` or `-journal` file ever appears in the cloud folder during the suite, and every vault file has a WAL header and opens the way iOS 1.0.5 opens it.

**mcp** (MCP tools on real devices)
- `tools-list`: tools/list has the vault tools and `entry_list` works on an unlocked vault.
- `no-daily-quota`: a Free user makes 60 tool calls (the old cap was 50); none is refused and no quota file is written.
- `writes-sync`: on Pro, MCP note and document writes show on the device and reach a second device.
- `has-conflict`: a same-field conflict makes `entry_info` report `has_conflict: true` until it is resolved in the review panel.
- `locked-and-elsewhere`: a locked vault returns `code: VAULT_LOCKED`; after a Free take-over from another device it returns `reason: open_elsewhere` and the device shows the locked-out dialog.
- `audit`: every MCP call of the run is in the MCP audit log, in order, with the right outcome; secrets such as `api_key` show as `[REDACTED]`.

**ownership** (vault ownership and plan limits, `docs/PLAN_ENFORCEMENT.md`; `npm run verify:ownership`, about 3 minutes)
- Owner and grace banners, grace ending with [Make my own copy], release and hand-over, release surviving a background re-acquire, the owner tag signed out and offline, the account device cap, the minimum app version, and the cloud backup plan gate. Details and wording: `.claude/skills/verify-ownership/SKILL.md`.

**password** (master-password changes on a synced vault, spec 4.7 and 4.8; `node scripts/verify/run.mjs password`, about 1 minute)
- `change-while-both-open`: on Pro, A changes the password (Vault > Change Password...); B shows "Syncing paused" naming the device, stops publishing, takes [Later] and keeps editing (a host and a secret); the old password is refused there; with the new one B's edits reach A, both show the same entries and every secret decrypts; after a lock the old password gets "Invalid master password" on both and the new one unlocks.
- `change-while-other-closed`: B stops with an unpublished edit; A changes the password; B's old password opens only B's own copy and pauses syncing (spec 4.8 unlock policy); the new password merges B's edit and A's later edit on both devices.
- `erase-recently-deleted`: the change with "Also permanently delete items in Recently deleted" redacts the grave in the shared file and leaves nothing to restore on either device.
- `older-file-old-password`: when the cloud drive brings back the file from before the change, the old password gets "Master password changed" naming the device; the new password there unlocks and republishes under the new key.
- Every scenario checks the shared file: two key epochs with the old salt and verifier redacted, a WAL header, the iOS 1.0.5 open, and no `-wal`, `-shm` or `-journal` file.

**lifecycle** (vault lifecycle, spec 4.7, 5.9 and Settings > Sync; `node scripts/verify/run.mjs lifecycle`, about 3 minutes)
- `recently-deleted`: on Pro, an entry with a password (and a password history row) deleted on A shows in Recently deleted on A and B; [Restore] on B brings it back on both with its password; deleted again and erased with "Delete permanently" on A, it leaves both lists (an "Erased permanently" record stays), the shared file's grave has `row_json` NULL and `redacted = 1`, every register is redacted, and no name, host, username, notes or password cipher (current or old) is left in the file's bytes.
- `rename-and-rebind`: A renames the vault with File > Rename Vault...; A keeps working at the new path; about 33 s later B shows "Found the vault file under its new name." with [Undo], follows the new path (sync state, `vault_get_path`, recent vaults), both keep syncing, nothing recreates the old file, and after a relaunch B's hub offers only the renamed file and opens it.
- `make-separate-vault`: opening a copy of a synced vault on the same device offers "'Vault.conduit' is a copy of ..."; [Use as a separate vault] writes a new file with a new lineage, genesis and vault id; [Open it] opens it with the same password; its edits never reach the original, which stays byte-for-byte the same.
- `damaged-working-copy`: A's working copy is corrupted while A is closed and B publishes a new entry; at unlock A shows "This computer's copy is damaged"; [Rebuild from shared file] opens the vault with the shared file's data (B's entry, A's password), parks the damaged copy byte for byte, and A syncs again.
- `idle-auto-lock`: "Lock the vault when idle" saved in Settings > Security persists in the dialog, settings.json and across a relaunch; with the system idle time stubbed in the main process, 299 s idle keeps the vault open, 300 s locks it at the next 30 s check and releases the lease; the OS screen lock locks at once; with the setting Off the screen lock does nothing.
- `settings-sync-tab`: Settings > Sync shows "one device at a time" and limit 1 for Free, "any number of devices at once" and limit -1 for Pro, and the devices list ("(this device)", "Open now"; the other device turns "Closed" after it quits).

**copies** (copies of a vault, spec 5.5, 5.8 and 5.10; `node scripts/verify/run.mjs copies`, about 2 minutes)
- `provider-conflict-copy`: on Pro, a third device's published edit lands next to the shared file as "Vault (conflicted copy ...).conduit"; A merges it within a second with the toast "Merged changes from a copy Dropbox made." and publishes it; the copy stays in place byte for byte, and B, opening later, has the edit and lists the copy as "Nothing new" with [Move to Trash].
- `user-copy-review`: "Vault 2.conduit" edited by desktop 0.17 (3 entries deleted, 1 host changed) shows the notice "... 4 changes that aren't in your vault, including 3 deletions." and is never merged on its own; [Ignore this copy] and [Don't merge] after the preview ("Different values (1)", "Deleted in this copy (3)") change nothing on A, B or the shared file; [Merge] applies the edit and the deletions, except an item B changed while the preview was open, which becomes one "Deleted and edited" review item ([Keep item] keeps it); the deleted items show in Recently deleted.
- `side-files-pause`: `-wal`/`-shm` next to the shared file show the side-files banner on both devices; A's new entry and edit stay on A and are not published (checked for 10 s, several times the measured normal publish time) while the status is "Paused (older Conduit open)"; [Conduit is closed on my other computers] moves both files into A's `sidefiles-<ts>/` folder (not deleted), publishing resumes within 5 s (measured 0.3 s), B gets the held edits and both banners go.
- `mass-delete-undo`: on Pro, A deletes a folder with 12 entries; B applies it, takes one pre-merge snapshot (on disk) and shows "A sync from another device deleted or changed 13 items." with [Review]; a single delete before takes no snapshot; after an unrelated later edit from A, Undo lists exactly the folder and its 12 entries, "Undid 13 changes." restores them with their values and folder on both devices, and keeps the later edit and the earlier single delete.
- `different-copies`: on Pro, A syncs `.../Dropbox/Vault.conduit` and B a copy at `.../OneDrive/Vault.conduit` (same lineage); B shows "Two copies of this vault" at unlock (from A's presence in the copy) and A about 15 s later (from B's session row, since A's file never held B's presence); [Merge them...] with the other file on each device previews its one change, merges it and publishes, so both copies hold both edits.

**backup** (local and cloud backups, spec 5.10, 8.1 and 8.2; `node scripts/verify/run.mjs backup`, about 2 minutes)
- `local-backup-rollback`: on Free, Settings > Backup turns local backup on into a folder under the run dir; two new entries make a backup file on their own about 5 s later; decrypted, it is a WAL-header SQLite file with no free pages and this vault's lineage, with no `-wal`, `-shm`, `-journal` or `.tmp` next to it. After a password change and a delete, "Restore from backup" (the app's own preview dialog, fed by `local_backup_restore`, since the app has no local-restore screen) lists the deleted entry and "1 newer value will be replaced"; [Roll this vault back] brings the entry and the old password back, keeps the replaced password in password history with `changed_by` "rollback" (and the earlier manual change), matches the backup exactly and is published. With the shared folder read-only, a backup still holds an entry that only the working copy has, so backups read the working copy.
- `rollback-syncs`: the same rollback on Pro device A reaches device B (entry, password and the "rollback" history row) about 2.5 s later.
- `restore-as-new-vault`: [Restore as a new vault...] writes a file with the backup's entries, a new lineage and a WAL header, without writing the original; [Open it] opens it with the same password; the original keeps its lineage, vault id, entries and history.
- `cloud-backup-plan-gate`: on Free, the Cloud Backup toggle is disabled with a "Pro and Team" badge and "Upgrade to Pro or Team to back up your vault to the cloud.", `cloud_sync_enable` and `cloud_backup_restore` are refused with the plan messages, and the `vaults` bucket stays empty. On Pro, the toggle turns backup off and on again; the upload lands under `<user id>/<vault id>/` (`storage.objects`), `cloud_backup_list` shows it, and a Backup Manager restore of it goes through the preview and brings a deleted entry back. Downgraded to Free while open, the still-shown toggle is refused with the toast "Could not change cloud backup: Cloud backup needs the Pro or Team plan." and nothing is uploaded.
- `downgraded-backup-stops`: a Pro vault with cloud backup on is locked, the plan is set to Free, and after the next unlock an edit uploads nothing for 15 s (an edit on Pro reached the bucket in about 5.2 s) and cloud backup shows off.

**resilience** (offline use and reconnect, cached tier, team vaults, export and import; spec 4.2, 6.5-6.8; `node scripts/verify/run.mjs resilience`, about 2.5 minutes)
- `offline-open`: on Free, with the device's Supabase link cut after sign-in, a vault is created, locked and opened again; it shows "Offline: device check paused" in Settings > Sync, keeps limit 1, and its edits reach the shared file while the server has no lease row. When the link returns, an active lease row for that vault appears with no user action (about 60 s, the offline retry) and the badge clears.
- `offline-takeover-reconnect`: on Free, A's link is cut after its offline edits publish; B (its own drive folder, fed A's file) is offered a take-over because the server still sees A, takes it and has A's offline edits. A keeps working, unaware, until its link returns; its next heartbeat (about 30 s) shows "This vault is now open on ..." with "Your changes from this device were saved.", A soft-locks, reports its final save (row still displaced by B's take-over), and its shared file holds every edit, including one made after the take-over.
- `cached-pro-offline`: a Pro user signs in once online on two devices, which then relaunch with Supabase cut (cached auth mode). While a signed-out device holds the owner claim, the device with an 8-day-old cached tier and the one with a cache dated a day ahead get the one-device take-over dialog (limit 1, source `default`); the device with the normal cache opens with no prompt (limit -1, source `tier-cache`) and its edit reaches the online device, the only one with a server lease.
- `team-vault-regression`: a Team user creates a team vault on A (identity key, `team_vault_create`), adds entries that reach `vault_entries`, and B (identity key recovered with the passphrase) opens it and gets them by team sync. No personal-sync lineage folder, sync lineage in the team vault file, running personal sync or `personal_vault_sessions` row appears for it; after "Lock Current Vault" both devices reopen the personal vault and its edits sync both ways.
- `import-export`: on Pro, `export_execute` writes a folder, a credential, an SSH entry using it and a web entry; the preview reads it and a wrong passphrase cannot. Imported into another vault that has an open same-field conflict on both devices, the entries arrive with new ids, the folder, the remapped credential and their secrets, sync to the other device, and the conflict stays open with both values.

## Prerequisites (the harness checks or fixes these itself)

| Need | What the harness does |
|---|---|
| macOS or Linux, Node 20+ | Preflight fails fast with a clear message otherwise. |
| Docker running | Preflight runs `docker info`; if it fails, start Docker Desktop and rerun. |
| Local Supabase on 127.0.0.1:54321 (API) and :54322 (DB) | Reuses a running stack (any workdir with project_id `conduit`); otherwise starts one with the pinned CLI `npx -y supabase@2.109.1 start --workdir ~/.cache/conduit-verify/supabase`. The pinned CLI is used on purpose because a Homebrew `supabase` binary can be broken. `SUPABASE_CLI` overrides it. |
| Seeded schema | If `public.tiers` is missing it restores the newest `~/conduit-backups/conduit-preview-*.sql` (auth schema errors during that restore are expected). The repo migrations cannot build an empty database on their own. |
| Current sync migrations | Applies `20260501000000_add_parent_entry_id.sql` and every migration dated `20260926000000` or later on every run (idempotent), then `scripts/verify/sql/local-parity.sql` (production's 23-argument `upsert_vault_entry_versioned`, the `vaults` storage bucket and its four policies, the team members RPC grant), then checks tiers (free `vault_max_open_devices=1`, pro and team `-1`, `mcp_daily_quota=-1`), the `vault_session_*` functions, `heartbeat_at` in `vault_sessions_for`, the parity objects and the team RLS helper grants. |
| psql, Electron, playwright-core, MCP SDK | Preflight finds them or says what to install. |
| Offline scenarios (resilience) | A per-device TCP proxy to 127.0.0.1:54321 (`lib/net-proxy.mjs`) passed to that device as `CONDUIT_DEV_SUPABASE_URL`, which only unpackaged preview builds honor, and only for a loopback URL; cutting it takes Supabase away from that one device while every other device and run keeps it. |
| Ports | Its own Vite on a free port, never 1420, so it runs beside the user's dev app. |
| Isolation | Each test device gets `/tmp/cv-<id>/<name>/` with its own HOME, app data, Chromium profile, single-instance lock and MCP socket, runs with `--use-mock-keychain`, and cannot claim `conduit://` links or the global shortcut. Test users are `verify-<runId>-<n>@conduit.local`. |

## Run it

From the repo root:

```bash
npm run verify                                   # all suites
node scripts/verify/run.mjs sync mcp             # several suites
node scripts/verify/run.mjs sync --only take-back          # one scenario (repeat --only for more)
node scripts/verify/run.mjs mcp --only audit --keep        # keep /tmp/cv-<id> device roots to inspect
node scripts/verify/run.mjs --help
```

Exit code 0 means every phase, scenario and cleanup step passed; 1 means something failed; 2 means
bad arguments. Suites run in file-name order: backup, copies, lifecycle, mcp, password, resilience,
smoke, sync (sync last, so its `file-safety` watch also sees what the other suites left in the cloud
folder). Test windows appear on screen: leave them alone.

The run id looks like `20260926-163755-1596d7`; the first output line prints it. Device roots live
in `/tmp/cv-<id>`, where `<id>` is the last six characters of the run id (`/tmp/cv-1596d7`), and
`results.json` `cleanup.keptRoots` holds the exact path after `--keep`.

## How long

About 12 minutes for all 41 scenarios (two consecutive full runs: 735.5 s and 738.9 s). Setup is
about 9 s; scenario time per suite in a full run: backup 120 s, copies 105 s, lifecycle 163 s,
mcp 48 s, password 52 s, resilience 150 s, smoke 4 s, sync 62 s. Most of it is the app's own
waits: the 30 s missing-file debounce, the idle lock's 30 s check, the 30 s heartbeat and 60 s
offline retry, the 5 s backup debounce and fixed windows that prove nothing is published or
uploaded.

Give the command a 20 minute timeout, and run it in the background if your tool caps a command at
10 minutes. A cold start of the Supabase stack (image pulls) can add several minutes the first time.

## Read the results

The last lines print a table and `RESULT: PASS|FAIL in <time>  (.verify/<runId>/results.json)`.
Everything for the run is in `.verify/<runId>/` (gitignored):

- `results.json`: `status`, `phases[]` (preflight, supabase, build, vite), `scenarios[]` with `status`,
  `durationMs`, timestamped `steps`, `error` (stack) and `failure[]` (per device screenshot path and
  main and renderer log tails), and `cleanup` (failures, leftover processes).
- `shots/`: numbered PNGs; `<n>-<device>-FAIL-<suite>-<scenario>.png` for every open device on a failure.
- `logs/`: `run.log`, `<device>.main.log`, `<device>.renderer.log`, `<device>.mcp.log`, `build.log`,
  `vite.log`, `supabase-*.log`, `cleanup.log`. Keys and tokens are redacted.

List the failures of the newest run:

```bash
node -e "const d=require('fs').readdirSync('.verify').filter(n=>/^\d{8}-/.test(n)).sort().pop();const r=require('./.verify/'+d+'/results.json');console.log(d,r.status);for(const s of [...r.phases,...r.scenarios].filter(s=>s.status!=='pass'))console.log(s.name??s.suite+'/'+s.scenario,'|',String(s.error).split('\n')[0])"
```

The table has no per-suite totals. Print passed / total and time per suite of the newest run (time is
the sum of scenario times, without device start-up and shut-down between scenarios):

```bash
node -e "const d=require('fs').readdirSync('.verify').filter(n=>/^\d{8}-/.test(n)).sort().pop();const r=require('./.verify/'+d+'/results.json');const t={};for(const s of r.scenarios){const x=t[s.suite]??={p:0,n:0,ms:0};x.n++;x.ms+=s.durationMs;if(s.status==='pass')x.p++}for(const [k,x] of Object.entries(t))console.log(k,x.p+'/'+x.n,(x.ms/1000).toFixed(1)+'s')"
```

## When something fails

1. Find the first failure in `results.json` and read its `steps`, `error`, screenshot and the device
   logs. Decide whether it is an app bug, a harness bug or the environment (see Troubleshooting).
2. Re-run just that scenario: `node scripts/verify/run.mjs <suite> --only <scenario>` (add `--keep`
   to look inside the device roots afterwards).
3. Fix the root cause, then add or update a unit test for it where the code allows.
4. Never make a run pass by weakening an assertion, deleting a check, skipping a scenario or raising
   a timeout without a measured reason. If a check disagrees with the spec
   (`docs/MULTI_DEVICE_SYNC.md`), say so and cite the section instead of quietly changing it.
5. If a scenario passes only sometimes, treat it as a real race and report it.
6. Finish with the full `npm run verify` again.

## Cleanup guarantees

On pass, fail or Ctrl+C (press once; a second press aborts cleanup) the run quits every test device,
stops its Vite, deletes its test users (their leases go with them) and their cloud backups in the
`vaults` bucket, removes `/tmp/cv-<id>/` and `.verify/<runId>/dist-electron/`, then kills and
reports any process that still mentions the run. A
leftover process or failed cleanup step makes the run FAIL. Each run also deletes `verify-*` users
older than 6 hours and, before it starts, prunes `.verify/` to the 20 newest run folders (so 21 exist
after a run). The local Supabase stack is left running. The build phase also rewrites the gitignored
`mcp/dist/` in the repo; that is expected and not undone.

`--keep` keeps only the device roots and `.verify/<runId>/dist-electron`; test users and their lease
rows are still deleted. After `--keep`, delete `/tmp/cv-<id>` and `.verify/<runId>/dist-electron`
yourself when done.

Quick check afterwards (works in zsh and bash; the trailing slash matters because `/tmp` is a symlink
on macOS): `find /tmp/ -maxdepth 1 -name 'cv-*'` prints nothing and
`ps ax | grep -F /tmp/cv- | grep -v grep` finds nothing (unless another run is going). Do not use
`ls -d /tmp/cv-*`: zsh prints `no matches found` when the folder is clean.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Docker is not running` at preflight | Docker Desktop is off | Start Docker Desktop, wait until `docker info` answers, rerun. |
| supabase phase fails, `supabase start` errors (for example a missing `supabase-go`), or the API does not answer | Broken Homebrew CLI, or a half-started stack | Do not point `SUPABASE_CLI` at the Homebrew binary. Check `curl -s http://127.0.0.1:54321/auth/v1/health` and `docker ps --filter name=supabase_`. If containers are unhealthy, run `npx -y supabase@2.109.1 stop --workdir ~/.cache/conduit-verify/supabase` and rerun; the harness starts it again. See `logs/supabase-start.log`. |
| `public.tiers is missing and no ~/conduit-backups/conduit-preview-*.sql backup exists` | Fresh database and no dump to seed it | Ask the user to put a preview backup in `~/conduit-backups/` (see `docs/LOCAL_SUPABASE.md`). Never create one from production. |
| `Local Supabase schema check failed` | Tier values or `vault_session_*` functions are wrong | Read `logs/supabase-migrate.log` and fix the migration, not the check. |
| Supabase ports 54321 or 54322 busy | Another Supabase project is running | `lsof -nP -iTCP:54321 -sTCP:LISTEN`. Ask the user before stopping another project's stack. Vite ports are picked automatically. |
| A device times out on a page call, or a macOS keychain prompt is on screen | Some code path reached the real keychain | Never answer the prompt. Let the run fail (cleanup kills the device) or SIGKILL only that device's pid. Find the call in `<device>.main.log` and fix the isolation (`scripts/verify/lib/launcher.mjs`). |
| `EINVAL` on the MCP socket, or `too long for the MCP socket path` | Unix socket path over 104 bytes | Keep device names 1 to 12 characters and device roots at `/tmp/cv-<id>/<name>`; never move them under `$TMPDIR` or the repo. |
| `Device name "<name>" was already used by <suite>/<scenario>` | Two scenarios, often in different suites, launch the same name; a device root lasts the whole run, so the second would inherit the first one's sign-in and device id | Rename the newer scenario's devices with its suite's prefix (backup `b`, copies `c`, lifecycle `l`, mcp `m`, password `p`, resilience `r`, sync `s`). |
| `createVault: <path> already exists` | Two scenarios use the same `<cloud>/<folder>/` (the hub would open the old file and wait for "Set a master password" in vain) | Name the folder with the suite's prefix, like its devices. |
| `playwright-core is not installed`, MCP SDK not resolvable, Electron binary missing | Dependencies not installed | `npm install` and `(cd mcp && npm install)`. |
| `psql not found` | libpq missing | `brew install libpq`, or set `PSQL=/path/to/psql`. |
| build phase fails | TypeScript error | Read `logs/build.log`; run `npx tsc --noEmit -p electron/tsconfig.json`. |
| `[cleanup] FAIL` or `leftover process killed` | A device or client did not shut down | Read `logs/cleanup.log` and fix the quit path; the run counts as failed. |

## Safety rules

- Only the local stack on 127.0.0.1. Never point the harness, `psql` or any env var at production
  Supabase or another cloud project, and never set `CONDUIT_ENV=production`.
- Never touch the user's dev profile (`~/Library/Application Support/conduit/conduit-dev`, the
  "Conduit Dev" app), their running dev app or its Vite on port 1420, or `~/.claude.json`.
- Never answer a macOS keychain prompt.
- Only kill processes that belong to the run (their command line mentions `/tmp/cv-<id>` or
  `.verify/<runId>`).
- Never run `supabase db reset` on the local stack: the repo migrations cannot rebuild it.
- Never print the service-role key or session tokens.

## Report back

One line with the overall result and time, then one line per suite (passed / total and time, from
the per-suite command in "Read the results"), then
each failure with its root cause, the fix or the open question, and the run folder
(`.verify/<runId>`). Quote the `RESULT:` line as printed. Never say a run passed unless it ran and
printed `RESULT: PASS`.
