# Live verify harness

Runs the real Conduit app (Electron main process, Vite renderer, MCP server) against local Supabase,
drives it with playwright-core, and reports pass or fail. An agent can run it end to end with no help.

```bash
npm run verify                  # every suite in scripts/verify/suites
npm run verify:sync             # node scripts/verify/run.mjs sync
npm run verify:mcp              # node scripts/verify/run.mjs mcp
npm run verify:data             # backup, copies, lifecycle, password and resilience
node scripts/verify/run.mjs lifecycle     # one suite
node scripts/verify/run.mjs smoke --only two-devices --keep
```

Exit code: 0 when every phase, scenario and cleanup step passed, 1 on any failure, 2 on bad arguments.

## Suites

Suites run in file-name order, whatever order the command names them in. Times are the sums of
scenario times in a full `npm run verify` with nothing else running (41 scenarios, about 12 minutes
in all); each suite alone adds about 8 s of setup.

| Suite | Scenarios | About | Skill | Covers |
|---|---|---|---|---|
| `backup` | 5 | 113 s | `verify-data` | Local backup, rollback, restore as a new vault, cloud backup plan gate and downgrade |
| `copies` | 5 | 105 to 145 s | `verify-data` | Conflict copies, user copies, side files, mass-change undo, two copies |
| `lifecycle` | 6 | 160 s | `verify-data` | Recently deleted, rename and rebind, separate vault, damaged copy, idle lock, Sync tab |
| `mcp` | 6 | 44 s | `verify-mcp` | MCP tools, no daily quota, MCP writes that sync, conflicts, lock errors, audit log |
| `password` | 4 | 50 s | `verify-data` | Master-password change on a synced vault |
| `resilience` | 5 | 148 s | `verify-data` | Offline open and reconnect, cached tier, team vaults, export and import |
| `smoke` | 2 | 4 s | none | Harness health |
| `sync` | 8 | 61 s | `verify-sync` | Take-over, merge and conflicts, plan changes, leases, owner claims, legacy writer, file safety |

`sync`'s `file-safety` watches the whole cloud folder from the sync suite's first scenario on, so in a
full run it also covers the files the earlier suites left there.

## What a run does

1. **preflight**: macOS or Linux, Node 20+, Docker running, psql found, Electron binary, playwright-core
   and the MCP SDK resolvable.
2. **supabase**: `ensureLocalSupabase()` (see below), then removes `verify-*` users older than 6 hours.
3. **build**: `tsc -p electron/tsconfig.json --outDir .verify/<runId>/dist-electron` (compiled tests are
   removed) and `cd mcp && npx tsc` (writes `mcp/dist`).
4. **vite**: a private Vite on a free port (never 1420) with its own cache in `.verify/vite-cache`.
5. **scenarios**: each suite's scenarios in order. Devices and MCP clients a scenario opens are closed
   when it ends, pass or fail.
6. **cleanup** (always, also on Ctrl+C): quit devices, stop Vite, delete this run's test users and
   their cloud backups in the `vaults` bucket (also with `--keep`), remove `/tmp/cv-<id>` and the
   compiled `dist-electron/` unless `--keep`, then kill and report any process still mentioning the
   run. Local Supabase is left running, and the gitignored `mcp/dist` from the build step stays.

`<id>` is the last six characters of the run id (run `20260926-163755-1596d7` uses `/tmp/cv-1596d7`).
After `--keep`, `results.json` `cleanup.keptRoots` holds that path. Check for leftovers with
`find /tmp/ -maxdepth 1 -name 'cv-*'` (the trailing slash matters on macOS, where `/tmp` is a symlink;
`ls -d /tmp/cv-*` errors in zsh when nothing matches).

Artifacts land in `.verify/<runId>/` (gitignored): `results.json`, `logs/` (`run.log`, `<device>.main.log`,
`<device>.renderer.log`, `<device>.mcp.log`, `build.log`, `vite.log`, `supabase-*.log`, `cleanup.log`)
and `shots/` (numbered PNGs; `FAIL-*` shots plus log tails are captured for every open device on failure).
Tokens and keys are redacted in every log. Before a run starts, `.verify/` is pruned to the 20 newest run
directories, so 21 exist after it.

## Isolation

Each device gets `/tmp/cv-<id>/<name>/` with its own `home/` (HOME), `appData/` (set by a launcher app
before the compiled `main.js` loads, so it also gets its own Chromium profile and single-instance lock),
data dir `appData/conduit/conduit-dev/` and MCP socket `home/Library/Application Support/conduit-dev/conduit.sock`.
Roots stay short because macOS caps socket paths at 104 bytes. Electron runs with `--use-mock-keychain`
and a minimal environment (`CONDUIT_ENV=preview`, `CONDUIT_DEV_SERVER_URL=<private Vite>`).

The launcher (`lib/launcher.mjs`) also keeps test instances from touching the real machine: it no-ops the
`conduit://` protocol registration and the global picker shortcut, and blanks the `ps` scan of the
startup stale-MCP reaper so a test app never signals processes outside its sandbox. The launcher has no
`dev-app-update.yml` and no `freerdp-helper/`, so the updater and the FreeRDP auto-build fail fast and
harmlessly (RDP cannot be tested this way). Test windows do appear on screen.

Nothing touches the user's dev profile (`~/Library/Application Support/conduit/conduit-dev`,
`Conduit Dev`), their running dev app, `~/.claude.json`, or production Supabase.

## Local Supabase

`ensureLocalSupabase()` uses `SUPABASE_CLI` or `npx -y supabase@2.109.1` with the workdir
`~/.cache/conduit-verify/supabase` (repo `config.toml` and `templates/`, empty `migrations/`):

- starts the stack if `http://127.0.0.1:54321/auth/v1/health` or the DB does not answer; a stack started
  from another workdir with project_id `conduit` is reused as is;
- if `public.tiers` is missing, restores the newest `~/conduit-backups/conduit-preview-*.sql`
  (auth schema errors during the restore are expected);
- grants the classic Supabase table privileges to `anon` / `authenticated` (the backup has none and
  current images no longer add them; without this, sign-in cannot read `user_profiles`);
- applies `20260501000000_add_parent_entry_id.sql` and every migration dated `20260926000000` or later on every run, so repo
  changes are picked up (they are idempotent);
- then applies `scripts/verify/sql/local-parity.sql` (`lib/supabase-parity.mjs`), in one transaction
  behind an advisory lock so parallel runs never replace the same function at once. It mirrors
  production: the team-sync RPC `upsert_vault_entry_versioned` with the 23-argument
  `p_parent_entry_id` signature (EXECUTE for `authenticated` only), the private `vaults` storage bucket
  with its four `storage.objects` policies (cloud backup), and the `get_team_members_with_email` grant;
- checks tiers (free `vault_max_open_devices=1`, pro and team `-1`, `mcp_daily_quota=-1`), the
  `vault_session_*` functions, the bucket, all four policies, the 23-argument RPC, and that
  `authenticated` can execute the team RLS helpers (`is_team_member`, `is_team_admin`,
  `is_team_vault_member`, `is_team_vault_admin`, `team_vault_has_members`, `shares_team_as_admin`,
  granted by `20260927020444_team_rls_helper_execute.sql`) and `get_team_members_with_email`;
- the stale-user sweep first deletes teams owned by stale `verify-*` users (a team blocks its owner's
  deletion).

## Writing a suite

Add `scripts/verify/suites/<id>.mjs` (the scenario below is an illustration; `suites/smoke.mjs` is a
working example):

```js
export default {
  id: 'sync',
  title: 'Personal vault sync',
  scenarios: [
    {
      id: 'free-second-device-blocked',
      title: 'A Free user opening the vault on a second device sees the take-over dialog',
      async run(ctx) {
        const user = await ctx.createUser('free');
        const [a, b] = await Promise.all([ctx.launchDevice('a'), ctx.launchDevice('b')]);
        await ctx.flows.signIn(a, user);
        await ctx.flows.signIn(b, user);
        const vault = `${ctx.cloudDir}/Shared.conduit`;
        await ctx.flows.createVault(a, vault, 'pw-123456');
        const res = await ctx.flows.openVault(b, vault, 'pw-123456');
        ctx.checkEqual(res.dialogs, ['Vault open on another device'], 'b is offered a take-over');
        await ctx.shot(b, 'takeover');
      },
    },
  ],
};
```

A scenario fails by throwing. Keep device names short (`a`, `b`, `m`; 1-12 of `[a-z0-9-]`).

### ctx

| Member | What it does |
|---|---|
| `launchDevice(name, {env, settings, args})` | Launch an isolated device (a name another scenario of the run used is refused). `env` adds variables (for example `CONDUIT_DEV_VAULT_DEVICE_LIMIT: '-1'`, or a Supabase proxy's `proxy.env`), `settings` overrides `settings.json` keys (onboarding, What's New, engine picker and telemetry are pre-dismissed; on a relaunch of the same name the keys the app saved before are kept and `settings` is merged over them), `args` adds Electron switches. Returns `{name, app, page, root, home, dataDir, socketPath, mainLog, rendererLog, pid}`. A relaunch returns a new object; the old one no longer counts as live. |
| `quitDevice(d)` / `killDevice(d)` | Normal quit (quit flush, lease release), SIGKILL after 25 s. `killDevice` simulates a crash. |
| `createUser('free'\|'pro'\|'team')` | Confirmed user `verify-<runId>-<n>@conduit.local`, random password, plan set in `user_profiles`. Returns `{id, email, password, role}`. Deleted at cleanup. |
| `setTier(userId, role)` | Change a user's plan mid-scenario. |
| `createTeam(owner, {name, seats, members})` | Team owned by `owner` (admin), `members` `[{user, role}]`, `primary_team_id` set; see Teams below. Removed at cleanup before the users. |
| `supabaseProxy()` | A TCP proxy to the local Supabase for one device (see Offline below). Closed when the scenario ends, after its devices quit. |
| `onClose(label, fn)` | Runs `fn` when the scenario ends, after its devices quit (newest first; a failure is logged, not thrown). |
| `sql(query, vars)` / `sqlJson(query, vars)` | psql as `postgres`; use `:'name'` placeholders with `vars`. |
| `leaseRows(email)` | That user's `personal_vault_sessions` rows (status, device, displacement, markers). |
| `connectMcp(device)` | Stdio MCP client on the device socket: `listTools()`, `callTool(name, args)` (parsed JSON, throws `McpToolError`), `callToolRaw(...)` (`{isError, text, data}`). |
| `shot(device, label)` | Screenshot into `shots/`. |
| `check(cond, msg)` / `checkEqual(actual, expected, msg)` | Assertions (deep equality). |
| `waitFor(fn, {timeoutMs, intervalMs, label})` / `sleep(ms)` | Poll a Node-side async predicate until truthy. |
| `step(msg)` | Timestamped progress line in the report. |
| `cloudDir`, `runId`, `run` | The run's shared "cloud" folder (vaults here count as shared), ids and paths. |
| `flows`, `ui` | The helper modules below. |

### flows (`lib/flows.mjs`)

`currentScreen(d)` (`auth`, `hub`, `main`, `loading`), `waitForScreen(d, screen)`, `enterLocalMode(d)`,
`signIn(d, user)` (password grant, then the real `conduit://auth/callback` deep link through `open-url`;
returns `{email, tier}`), `signOut(d)`, `createVault(d, path, pw)` (hub "New Vault" with the save dialog
stubbed), `openVault(d, path, pw, {expect})` (hub "Open Vault File"; returns `{outcome: 'unlocked'}`,
`{outcome: 'dialog', dialogs, text}` for sync dialogs such as "Vault open on another device", or
`{outcome: 'error', text}`; `expect: 'unlocked'` throws otherwise), `waitForUnlockOutcome(d)`,
`openDialogs(d)`, `lockVault(d)`, `addEntry(d, fields)`, `updateEntry(d, id, patch)`, `deleteEntry(d, id)`,
`listEntries(d)` (IPC `entry_*`, then the renderer is told to reload), `refreshEntries(d)`,
`openConflictReview(d)`.

### ui (`lib/ui.mjs`)

`invoke(d, channel, args)` / `invokeResult(...)` (renderer IPC through `window.electron.invoke`),
`mainEval(d, fn, arg)` (main process), `bodyText(d)`, `waitForText(d, text|regex)`,
`clickText(d, label, {exact, selector, index})`, `clickSelector(d, css)`, `typeInto(d, css, value)`,
`exists(d, css)`, `pressKey(d, key)`, `dispatchDocumentEvent(d, type, detail)`, `screenshot(d, label)`,
`readSyncState(d)` (`sync_get_state`), `stubFileDialogs(d, path)`, `withTimeout(promise, ms, label)`.

Useful IPC channels: `auth_get_state`, `auth_sign_out`, `vault_is_unlocked`, `vault_lock`,
`entry_list/create/update/delete`, `sync_get_state`, `sync_now`, `sync_list_devices`,
`sync_list_conflicts`, `sync_resolve`, `sync_list_copies` (see `electron/ipc/sync.ts`, `sync-review.ts`).

### Sync helpers (`lib/sync-flows.mjs`, `lib/sync-files.mjs`)

Import them directly in a suite (they are not on `ctx`). `suites/sync.mjs` uses both.

- `sync-flows.mjs`: `dialogDetails(d)` (`[{title, text}]`), `waitForDialog(d, title|regex)`,
  `waitForDisplaced(d)` (the soft-lock modal, "Vault locked" or "Opened on <device>", once the "Saving your
  last changes..." overlay has gone), `displacedShown(d)` (overlay or modal),
  `unlockOutcome(d)` (like `flows.waitForUnlockOutcome`, but rides out "Opening..." and the stale-file
  wait, pressing [Open now] after 30 s), `useHereFromTakeover(d)`, `useHereFromDisplaced(d, password)`,
  `conflictCount(d)`, `listConflicts(d)`, `entryById(d, id)`, `waitForEntry(d, id, pred)`,
  `waitForEntryInUi(d, name)`, `useVersionInReview(d, fieldLabel, value)`, `clickInReview(d, label)`,
  `closeReview(d)`.
- `sync-files.mjs`: `sharedEntries(file, scratchDir)` (reads the shared file through a private copy, so
  no side files appear next to it), `sqliteHeader(file)` (bytes 18/19), `openLikeIos105(file, scratchDir)`
  (`PRAGMA journal_mode = WAL` inside `BEGIN IMMEDIATE`, on a copy), `legacyEditInPlace(file, id, patch)`
  (a desktop 0.17 style in-place UPDATE, TRUNCATE checkpoint and clean close; returns side files left),
  `sideFilesNextTo(file)`, `deviceUuid(d)` (from `device.json`, to match lease rows), and
  `createSideFileWatch(root)` (polls every 200 ms for `-wal` / `-shm` / `-journal`; `expect(fn)` marks a
  window where they are intended).

### Offline (`lib/net-proxy.mjs`)

Makes one device lose Supabase while the shared stack keeps serving every other run:

```js
const proxy = await ctx.supabaseProxy();              // 127.0.0.1:<free port> -> 127.0.0.1:54321
const d = await ctx.launchDevice('o1', { env: proxy.env });  // CONDUIT_DEV_SUPABASE_URL
proxy.cut();      // resets open connections (HTTP keep-alive and the Realtime websocket) and new ones
proxy.restore();  // lets connections through again
proxy.stats();    // {accepted, refused, reset, open}
```

`CONDUIT_DEV_SUPABASE_URL` is honored only by unpackaged builds on the preview environment and only
for an http(s) loopback URL (`electron/services/env-config.ts`); packaged builds ignore it. Measured:
after `cut()` the main log shows `[vault-session] realtime error` at once, but the lease turns
unconfirmed (`status.sessionBadge` `'offline-device-check'`) only at the next failed heartbeat: up to
30 s later, or within about 3 s when an edit publishes (a publish triggers a heartbeat). A device that
opens while cut shows the badge at once. After `restore()` a device with a lease clears the badge at its
next heartbeat (about 30 s); a device that opened offline (no lease id) acquires at its next 60 s retry
(spec 6.2; measured 59.6 to 60.5 s). `startNetProxy(port)` is exported for other targets.

### Settings file (`lib/settings-file.mjs`)

`settingsPath(deviceOrRoot)`, `readDeviceSettings(deviceOrRoot)` (`{}` when missing),
`writeDeviceSettings(deviceOrRoot, patch, {allowRunning})` (merge, tmp + rename; refuses a running
device because the app rewrites the whole file on every save), `waitForSetting(d, key, pred)`. For a
new device pass `launchDevice(name, {settings: {vault_idle_lock_minutes: 5, local_backup_path: ...}})`.

### Vault files (`lib/vault-files.mjs`)

- `snapshotSharedFile(file)` (bytes, plain read) to make a copy that differs later.
- `makeProviderConflictCopy(file, {style, owner, date, bytes})`: `dropbox` `<stem> (conflicted copy
  <stamp>).conduit`, `dropbox-named` `<stem> (<owner>'s conflicted copy <stamp>)`, `syncthing`
  `<stem>.sync-conflict-<stamp>-VERIFY1`; `providerCopyName(...)` gives the name only.
- `makeUserCopy(file, {name = '<stem> 2.conduit', bytes})`. Both write through a temp name without
  the `.conduit` extension and rename it in. Edit a copy with `sync-files.mjs legacyEditInPlace` to
  give it a change (it is then listed as needing review).
- `lineageIdOf(file, scratchDir)`, `syncRootOf(d)`, `workingCopyPath(d, lineageId)`,
  `corruptWorkingCopy(d, lineageId)` (device must be closed; overwrites the first 4 KiB, which SQLite
  reports as SQLITE_NOTADB), `parkedWorkingCopies(d, lineageId)` (after "Rebuild from shared file").
- `placeSideFiles(file, {wal: 'empty' | 'edit', edit: {entryId, patch}, scratchDir, shm})`: `-wal`
  (empty, or a real WAL with one unsaved UPDATE) and a 32 KiB `-shm`, like an older desktop that has
  the file open; `removeSideFiles(file)` returns what it removed. Remove them before the scenario ends
  (for example with `ctx.onClose`): the sync suite's watch treats any side file under the cloud folder
  as a violation.

### Teams (`lib/team.mjs`)

`createTeam(run, owner, opts)` (or `ctx.createTeam`) inserts `teams` and `team_members` (the
`trg_team_member_sync` trigger sets `user_profiles.is_team_member`) and sets `primary_team_id`, which is
where the app reads the team from. Create the team before `signIn`, or call `invoke(d, 'auth_refresh')`
after. `addTeamMember(team, user, role)`, `deleteTeams(ids)` (also removes what team vaults leave in
tables without cascades), `sweepStaleTeams()`. App IPC: `ensureIdentityKey(d)` (`identity_key_generate`
when needed), `createTeamVault(d, team, name)` (`team_vault_create`), `openTeamVault(d, id)`
(`team_vault_open`; the renderer is not told, dispatch `conduit:team-vault-unlock` with `{id, name}` for
the UI path). Entries written in an open team vault reach `vault_entries` through the 23-argument RPC.

### UI forms and toasts (`lib/ui-forms.mjs`)

`typeIntoLabeled(d, label, value, {scope})` (the sync dialogs' labeled password fields),
`selectOption(d, css, value)`, `setCheckbox(d, text, checked, {scope})`, `dialogSelector(title)`,
`clickInDialog(d, title, label)`, `banners(d)` / `waitForBanner(d, text)` / `clickBannerAction(d, text,
label)` (the `role=status` strips above the main area), `stubDialogs(d, {open, save})` (separate answers;
`open` may be a folder), `clickMenuItem(d, 'Change Password...')` (the real application menu),
`retryUntil(attempt, done, opts)`.

Toasts render in a separate overlay window created on the first toast, and a 5-second toast can be gone
before that window has loaded. The launcher therefore records every toast in the main process:
`toastLog(d)` (`[{id, type, title, message, actions, at}]` since launch), `toastMark(d)` and
`waitForToast(d, title, {after: mark})` (take the mark before the action when a title repeats),
`toasts(d)` (on screen now), `clickToastAction(d, title, label)` (sends the overlay's own
`overlay:action-clicked` message). `overlayPage(d)` is the overlay window itself.

### Settings flows (`lib/settings-flows.mjs`)

`openSettings(d, tab)` (tab ids in `SETTINGS_TABS`; waits until the dialog has loaded settings.json,
which otherwise overwrites an early edit), `switchSettingsTab(d, 'Security')`, `saveSettings(d)`,
`cancelSettings(d)`, `setIdleLockMinutes(d, 0|5|15|30|60)` (Security tab, then Save),
`readSyncTab(d)` (`{sections, status, detail, plan, devices, notices, paused, text}`),
`syncNowFromSettings(d)`, `openSyncTool(d, 'Review changes' | 'Recently deleted' | 'Other copies')` (the
panel opens above Settings, which stays open under it), `syncTabNoticeAction(d, text, 'Review' | 'OK')`,
`changeMasterPassword(d, current, next, {eraseRecentlyDeleted})` (Vault menu > Change Password...;
`{ok: true}` or `{ok: false, error}`; `eraseRecentlyDeleted: true` ticks "Also permanently delete items
in Recently deleted", which the dialog shows only for a synced vault).

### Sync dialogs (`lib/sync-dialogs.mjs`)

- `promptKinds(d)`, `waitForPrompt(d, kind)` (engine prompts from `sync_get_state`).
- "Syncing paused" (a password changed on another device while this one runs):
  `answerEpochPrompt(d, password, {previousPassword, keep: 'this-device' | 'other'})` returns
  `{ok: true}` or `{ok: false, error}` ("That password didn't work."); `deferEpochPrompt(d)` ([Later]).
  A device that reopens with its own older password unlocks and then shows this prompt; there the
  old password is refused with "That is an older password. Enter the newest one."
- "Master password changed" at unlock: `submitPasswordChanged(d, newPassword, {previousPassword})`.
  It appears only while some file still holds the old password's verifier (4.8 redacts it once the
  change is published): the password suite brings back the pre-change shared file to reach it. With
  the current file an old password is just "Invalid master password".
- "This computer's copy is damaged" at unlock: `rebuildDamagedCopy(d)` returns the unlock outcome.
- Side files: `waitForSideFilesBanner(d)`, `confirmSideFilesBanner(d)` (clicks [Conduit is closed on my
  other computers], [Continue] or [Review unsaved changes first]; the last opens the candidate
  preview; toast "Syncing resumed.").
- File not found (the banner appeared about 35 s after the file moved): `waitForFileMissingBanner(d)`,
  `locateMissingVault(d, path)` (toast "Found the vault file. Syncing again."), `saveNewCopyHere(d,
  path)`, `keepWorkingHere(d)`.
- Copies: `keepCopiesSeparate(d, target)` / `mergeTwoCopies(d, copyPath)` ("Two copies of this vault"),
  `answerSameDeviceCopy(d, 'separate' | 'merge' | 'ignore', {copyName, targetPath})`. Opening another
  file of a vault the device already syncs shows "'<file synced before>' is a copy of '<opened
  file>'."; [Use as a separate vault] ends with the toast "Saved as a separate vault." and its [Open it].

### Sync panels (`lib/sync-panels.mjs`)

- Recently deleted: `recentlyDeletedItems(d)` (`[{title, detail, checked, erased}]`; an erased row has
  no title), `selectDeleted(d, titles)`, `restoreDeleted(d, titles)`, `deletePermanently(d, titles)`
  (confirms "Delete permanently?"), `deleteAllPermanently(d)`, `showOlderDeleted(d)`,
  `closeRecentlyDeleted(d)`.
- Other copies: `otherCopies(d)` (`[{name, path, text, actions}]`), `waitForCopy(d, name)` (presses
  [Scan again] between tries), `copyRowAction(d, name, label, {targetPath})`, `closeOtherCopies(d)`.
- Candidate preview "Merge '<label>'?": `candidatePreview(d)` (`{title, text, sections}`; section keys
  `Different values`, `Only in this copy`, `Deleted in this copy`, `Missing from this copy`),
  `mergeCandidate(d, {deleteMissing})` (toast "Merged." or "Merged. N changes to review."),
  `discardCandidate(d)` ([Don't merge]; toast "Copy set aside. Nothing was merged.").
- Mass change (another device deleted 10 or more items; toast "A sync from another device deleted or
  changed N items." with [Review]): `massChangeDetails(d)`, `undoMassChange(d, {uncheck})`,
  `keepMassChange(d)`.
- "Restore from backup": `restorePreviewDetails(d)` (`{text, nothing, deletions, restorations}`),
  `rollBackFromPreview(d)`, `restoreAsNewVaultFromPreview(d, target)` (toast "Backup restored as a new
  vault."), `cancelRestorePreview(d)`.

### Backup flows (`lib/backup-flows.mjs`)

`enableLocalBackup(d, folder)` (Backup tab toggle with the folder picker stubbed; waits for the first
backup file), `localBackupNow(d)`, `listLocalBackups(d)`, `localBackupRows(d)`, `localBackupState(d)`,
`restoreLocalBackup(d, file, password, {mode, targetPath})` (IPC `local_backup_restore`; the app has no
screen for a local restore; a synced vault answers `{mode: 'preview', preview}`),
`enableCloudBackup(d)` (Pro and Team have it on after unlock already; then nothing is clicked),
`cloudBackupNow(d)`, `listCloudBackups(d)`, `openBackupManager(d)`,
`restoreFromBackupManager(d, password, {index})` (newest first; opens "Restore from backup"),
`closeBackupManager(d)`.
`openLocalRestorePreview(d, file, password)` opens the app's own "Restore from backup" dialog for a
local backup: `local_backup_restore` answers with a preview, which goes to the renderer hook vaultStore
uses for cloud restores (`showRestorePreview`, loaded with a dynamic `import()` from the dev server);
its buttons re-run `local_backup_restore` as a rollback or a new vault. Returns the preview
(`{deletions, restorations, replacements, unreadableSecrets}`). `cloudBackupSection(d)` (`{badge,
toggleDisabled, text}` of Settings > Backup > Cloud Backup), `pressCloudBackupToggle(d)` (one click;
`'clicked'` or `'disabled'`), `disableCloudBackup(d)` (toggle off, waits until off).

### Backup files (`lib/backup-files.mjs`)

`decryptLocalBackup(file, password)` (the SQLite bytes, format of `local-backup-crypto.ts`),
`inspectVaultBytes(bytes, scratchDir)` / `inspectVaultFile(file, scratchDir)` (`{header: {magicOk,
writeVersion, readVersion, freelistPages}, quickCheck, lineageId, vaultId, entries, history}` through a
private copy), `localBackupContent(file, password, scratchDir)` (cached: the KDF runs 600,000 rounds),
`waitForLocalBackup(d, password, scratchDir, pred, {timeoutMs, label})` (newest backup whose content
matches; `{file, info}`), `strayFilesIn(dir)` (`-wal`, `-shm`, `-journal`, `.tmp`), `sha256File(file)`,
`cloudObjects(userId)` (the user's `storage.objects` in bucket `vaults`: `[{name, created_at,
updated_at, size}]`), `waitNewCloudBackup(userId, '<user id>/<vault id>', known, {timeoutMs})` (first
new object under `backups/`). A Pro vault's backups are `<user id>/<vault id>/vault.enc` (upserted) and
`<user id>/<vault id>/backups/vault_<YYYY-MM-DD_HH-MM-SS>.enc`, plus `<user id>/manifest.json`.

### Password checks (`lib/password-flows.mjs`)

`sharedKeyState(file, scratchDir)` (`{salt, epochs: [{epochId, parent, hasSalt, hasVerification}],
wraps}` of the shared file, oldest epoch first), `sharedGrave(file, scratchDir, rowId)` (`{redacted,
hasRowJson}` or null), `entrySecrets(d, ids)` (plaintext `password`, `private_key`, `totp_secret` from
`entry_get_full`, what the entry editor reveals), `entrySnapshot(d)` (entries without timestamps,
sorted by id, to compare devices), `recentlyDeletedList(d)` (`sync_recently_deleted`: `[{title,
redacted}]`; an erased item stays listed with no title), `unlockErrorLine(d)`, `cancelUnlockDialog(d)`.
A local edit publishes 2 s after the last edit, so `killDevice` right after an edit leaves it unpublished
(a normal quit's final sync would publish it).

### Lifecycle flows (`lib/lifecycle-flows.mjs`)

`renameVaultFromMenu(d, name)` (File > Rename Vault..., resolves with the toast 'Vault renamed to
"<name>"'), `unlockShownDialog(d, password)` (the unlock dialog the app opened by itself, for example
after the "Saved as a separate vault." toast's [Open it] or a recent vault clicked in the hub; returns
the unlock outcome), `recentlyDeletedIpc(d)` / `waitRecentlyDeleted(d, pred)` (poll
`sync_recently_deleted`; the panel itself loads once when it opens), and the idle auto-lock's inputs:
`stubSystemIdle(d, seconds)` replaces `powerMonitor.getSystemIdleTime` in the device's main process,
`idleChecks(d)` counts the reads made by the idle lock (`ipc/vault-idle.js`; the session host reads it
too and is counted apart), `emitLockScreen(d)` emits powerMonitor `lock-screen`. The idle lock checks
every 30 s, so a threshold test waits up to one interval per step.

### Vault inspection (`lib/vault-inspect.mjs`)

Read-only, through a private copy: `fileSha256(file)`, `vaultIdentity(file, scratchDir)`
(`{lineageId, genesisId, fileId, vaultId}`), `entryStorage(file, entryId, scratchDir)` (`{known,
contentRow, grave: {rowJson, redacted}, regs: {contentRegs, allRedacted}, history}`; `allRedacted`
means every register but `_life` has a zero vhash, flag bit 1 and no value), `storedPasswordCipher`,
`historyPasswordCiphers`, and `bytesContaining(file, {label: string | Buffer})` (labels found in the
raw bytes; a Buffer is also searched as base64 and hex, since a grave holds a secret as
`{"$b64": ...}`). Publishing uses VACUUM INTO, so erased values leave no free pages behind in the
shared file.

### Copies (`lib/copy-flows.mjs`, `lib/scenario-helpers.mjs`)

- `copy-flows.mjs`: `legacyEditedBytes(file, scratchDir, {deletes, patches})` (the bytes of a desktop 0.17
  session on a private copy: `DELETE FROM entries` per id, UPDATE with a fresh `updated_at` per
  `{id: patch}`, TRUNCATE checkpoint, clean close; hand them to `makeUserCopy` / `makeProviderConflictCopy`
  so the copy appears already edited, in one rename), `sha256Of(file)`, `lineageDir(d, lineageId)`,
  `sideFilesFolders(d, lineageId)` (`[{name: 'sidefiles-<ts>', files: [{name, size}]}]`),
  `listSnapshots(d)` / `undoPreview(d, id)` (pre-merge snapshots, 5.10), `waitForStatus(d, pred)` (the
  engine status: `kind`, `pauseReason`, `pendingPublish`, `unsyncedOps`, `prompts`, `otherCopies`;
  a timeout names the last one), `createFolder(d, name)`, `deleteFolder(d, id)` (the recursive delete),
  `listFolders(d)`, `presenceDevicesIn(file, scratchDir)` (device uuids with a presence register in a
  file) and `sessionFileHints(ctx, email)` (`[{device_id, status, file_id, file_name, location}]`).
- `scenario-helpers.mjs`: `vaultAt(ctx, ...dirs)`, `waitShared(ctx, file, pred, label)`,
  `signedInDevices(ctx, role, names)` (`{user, devices}`), `openVaultHere(ctx, d, file, password,
  {promptAtUnlock})` (requires an unlock; rides out a stale-file wait; `promptAtUnlock` is a dialog the
  engine may raise over the unlocked vault), `addNumberedEntries(ctx, d, prefix, net, n, extra)`,
  `entryFingerprint(ctx, d)` / `sharedFingerprint(ctx, file)` for "nothing changed" checks, `rowOf`,
  `scratchDir(ctx)`.
- The status stays `up-to-date` while side files are present and nothing needs publishing; it turns
  `paused` / `side-files` with the first local edit.
- After [Conduit is closed on my other computers] the confirming device publishes at once: the other
  device's side-files flag in its cached session rows was reported before the click, so the recorded
  confirmation (`local.json` `sideFilesConfirmedAtMs`) covers it (spec 5.5). A flag reported after the
  click still pauses, and a cycle runs as soon as a heartbeat shows the flag gone. Measured: the held
  edits reached the shared file 0.3 s after the click in 5 of 5 runs; `side-files-pause` allows 5 s.

### Offline and leases (`lib/offline-flows.mjs`)

`sessionFacts(d)` (`{badge, kind, limit, source, lineageId, softLocked}` from `sync_get_state`;
`source` is the effective limit's `server`, `local-json`, `tier-cache`, `default` or `dev-override`),
`waitSessionFacts(d, pred)`, `syncTabStatus(d)` (Settings > Sync `{status, detail, plan}`, then Cancel;
`detail` is `OFFLINE_TEXT` while unconfirmed), `leaseRowsOf(email, deviceUuid)`,
`ownerClaimOf(file, scratchDir)` (device uuid of the provisional `_sync/owner/owner` claim, or null),
and `deliverFile(from, to)`: a cloud drive delivering one device's file to another device's folder
(temp name, then rename). Give two devices their own folders with the same parent name
(`vaultAt(ctx, 'x', 'devA', 'Drive')` and `vaultAt(ctx, 'x', 'devB', 'Drive')`, so both have the
location `<kind>:Drive`) when one device must not see the other's publishes: in one shared folder a
Free device whose lease is unconfirmed is displaced by the other device's owner claim (spec 6.7) as
soon as it merges, before any server answer.

### Team flows (`lib/team-flows.mjs`)

`recoverIdentityKey(d, passphrase)` (a second device of the same user, with the passphrase
`ensureIdentityKey` returned), `activeVaultType(d)` (`vault_get_type`), `openTeamVaultInUi(d, {id, name})`
(the event the hub and the vault menu dispatch after locking the personal vault; waits for the main
screen), `openSidebar(d)`, `lockFromVaultMenu(d, vaultName)` (sidebar vault menu > "Lock Current Vault";
closes a team vault), `teamVaultFile(d, id)` (`<dataDir>/team-vaults/<id>.conduit`),
`serverTeamEntries(id)` (`vault_entries` rows) and `lineageDirs(d)` (`m-<hw>/<lineage>` folders under the
device's syncRoot).

### Export and import (`lib/vault-transfer.mjs`)

`exportVault(d, outputPath, passphrase, {scope, folderIds})` (`export_execute` of the active vault;
`{folderCount, entryCount}`), `previewExport(d, file, passphrase)` (`import_preview_export`),
`importExport(d, file, passphrase)` (`import_execute_export` into the active vault, then the renderer
reloads). The importer only creates folders and entries (new ids); it never writes an existing row.

## Gotchas

- Playwright locator clicks time out in this app. Use `ui.clickText` / `ui.clickSelector` (DOM clicks);
  `page.keyboard` works.
- Every page call has a timeout. A device blocked by a macOS keychain prompt shows up as a timeout;
  never answer the prompt, `killDevice` it and fix the isolation.
- IPC calls change data but not renderer state. The flows use the UI for vault open and create so the
  renderer stays in sync; entry helpers send `vault:entry-changed` like MCP writes do.
- All devices run on one machine, so they share the sync identity's hardware hint (`hw_hint`, the
  macOS IOPlatformUUID); each still gets its own device id.
- Native web views do not appear in page screenshots.
- A device root (`/tmp/cv-<id>/<name>`) lives for the whole run, so a later scenario that launches the
  same name would get the earlier sign-in, settings, recent vaults and device id. `ctx.launchDevice`
  therefore refuses a name another scenario of the run already launched (a relaunch inside the same
  scenario is fine). Names and cloud folders are run-wide, not suite-wide: each suite uses its own
  prefix (backup `b`, copies `c`, lifecycle `l`, mcp `m`, password `p`, resilience `r`, sync `s`;
  smoke uses `a`, `b` and `m`) for its devices and its `<cloud>/<scenario>/` folders.
  `flows.createVault` refuses a path that already exists, since the hub would open that file instead.
- A relaunch after "Continue without signing in" lands on the sign-in screen in about 1 of 3 dev
  launches (an app issue that is also on `main`): React StrictMode calls `auth_initialize` twice, each
  call also sends `auth:state-changed` without an `authMode`, and when that event arrives after both
  replies (events and invoke replies are not ordered) `authStore.handleAuthStateChanged` resets
  `authMode` to null. Sign the user in (the session persists) when a relaunched device must reach the hub.
- "Two copies of this vault" (another device syncs a different copy) fires when the other device's
  file hint has a different `file_id` or provider kind (`electron/services/sync/divergence.ts`). A byte
  copy carries the same `file_id` and a device opening it adopts it, so two copies in plain folders
  (both `local:`) are only caught by the 24-hour uncovered-marker rule, and a copy next to the shared
  file showed as needing review instead. The copies suite puts the two copies in folders named
  `Dropbox` and `OneDrive` (`dropbox:` and `onedrive:` locations) to get the prompt.
- The Settings dialog loads settings.json after it opens and then replaces its form; use
  `openSettings` (it waits) before changing a field.
- Cloud backup is per vault and off until turned on: in Settings > Backup, or by the new-vault form's
  "cloud backup" box, which is checked by default for Pro and Team (`createVault` leaves it so). A
  vault turned on while empty uploads nothing until its first edit, so the oldest cloud backup holds
  the first content; a restore from it can still remove every later entry.
- Vite serves the renderer in development mode, so React StrictMode runs every effect's cleanup once
  right after mount. Renderer code that clears state in an unmount cleanup breaks here first.
- A missing shared file is rebound (or the file-not-found banner shown) 30 s after the first missed read
  (spec 5.9 debounce); a rename on another device took 33 s to rebind in the lifecycle suite.
- The idle lock menu offers 5, 15, 30 and 60 minutes; any other positive whole number stored in
  settings.json shows as "Custom (N min)" and is kept on save (the main process honors it).
  `stubSystemIdle` makes the minute count irrelevant to wall time.
- On macOS every `/Volumes/...` path counts as a network path (`network-lock.ts`: polling, DELETE
  journal mode) and gets location kind `smb`; the devices list says "syncs on an external or network
  drive" for the run's cloud folder on an external disk.
- Every lock and quit of a synced vault publishes the shared file again (the final cycle writes
  `session_open = 0`, spec 6.4), so compare a shared file's content, not its bytes, across a lock.
- Cloud backup snapshot names carry milliseconds and a random tag
  (`vault_2026-09-26_14-03-07-412_a1b2c3.enc`, `electron/services/vault/cloud-backup-name.ts`), so
  uploads in the same second each keep a snapshot; order them by the object's `created_at`.
- The main process reads the plan at sign-in, start-up and token refresh (hourly); cloud backup
  checks call `authService.reloadProfile()` first, so `ctx.setTier` takes effect for them at once.
  Other main-process plan reads (tier capabilities) see the change only after such a reload, a
  token refresh or a relaunch; device limits come from the server.
- Test windows start with the sidebar collapsed, so the sidebar's sync indicator and vault menu are
  not in the DOM; `openSidebar(d)` opens it (or read the status from Settings > Sync).
- The AI panel starts its CLI agent terminal on launch, but an agent terminal nobody typed into (or
  quiet for 2 minutes) is no AI task, so idle test devices report `busy.jobs = 0` and the take-over
  and displaced dialogs mention no AI task.
- A device relaunched behind a cut proxy comes up in cached auth mode (`authMode: 'cached'`, the
  user id kept, "Working offline" banner on the hub), so it still counts as signed in (spec 6.8).
