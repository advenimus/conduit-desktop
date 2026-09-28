# Personal vault sync and device limits

Status: final spec, 2026-09-25. It merges the synthesized design with the red-team review (35 findings, all addressed in section 2.3).

**Scope.** Personal `.conduit` vaults on desktop (Electron, better-sqlite3) and iOS (GRDB). Team vaults keep their Supabase team sync and do not change. Removing the MCP quota is a separate change (section 8.3).

**Path roots used in citations.**
- `DESK` = this repository (conduit-desktop)
- `IOS` = the conduit-iOS-private repository (at 7276d35, v1.0.5)
- `WEB` = the conduit-website repository
- `BE` = the conduit-backend repository
- `PROBES` = `docs/sync-design-probes/` (design-time probe scripts: `register-sim.mjs`, `walprobe/probe.cjs`, `vacprobe.cjs`, `compactprobe.cjs`, `sqltest/`). Run the `.cjs` probes from the repo root so `better-sqlite3` resolves.

**Evidence tags.**
- **[V]** verified by reading the code or running a probe. Citations to the mapping reports count as [V] where the load-bearing lines were re-read.
- **[A]** assumed. Every [A] item is listed again in section 15.2 and must be tested.

---

## 1. Overview

### 1.1 What each plan gets

| Plan | Personal vault behavior |
|---|---|
| Free (also signed-out and local mode) | A vault can be open (unlocked) on one device at a time. "Use here instead" moves it. No MCP daily quota. |
| Pro | A vault can be open on any number of devices at once. The vault file lives in iCloud Drive, OneDrive, Dropbox, Google Drive or a network share. Edits merge per field. When two devices set the same field differently, the conflict is queued and the user picks. |
| Team | Everything in Pro, plus the existing team vaults, audit log and sharing. |

### 1.2 The design in brief

1. **The vault file is the transport.** All sync metadata lives inside the `.conduit` file in new `sync_*` tables. Merging two copies is a pure, deterministic function of the two files: commutative, associative and idempotent. Supabase holds only a small lease and presence table, never vault content.
2. **Every device works on a private working copy (W)** in machine-local app storage. The shared file (S) is only read and written as whole bytes. Desktop stops opening shared files in place, so it no longer creates `-wal`/`-shm` files in cloud folders.
3. **Each field is a multi-value register.** Every write carries a dot (replica id plus a hybrid logical clock stamp). Every file carries a version vector. Writes that did not see each other are kept side by side as siblings. Siblings with different values are a conflict for the user. Clock skew can change which value shows before the user decides. It can never drop data.
4. **Replica ids are fresh on every app launch.** A restored working copy can never reuse a dot, whatever was restored.
5. **Edits from older apps are absorbed, not blocked.** iOS 1.0.5 and desktop 0.17 or older are "legacy writers". A new build finds their edits by comparing content against stored per-field hashes and records each as a deterministic "pseudo" sibling. Three safety rules catch known bad legacy writes: dropped settings are kept, stale reverts become conflicts, and deletes are held for review while an old desktop has the file open.
6. **`vault_meta.schema_version` stays at 10.** A separate `vault_meta.sync_format = '1'` gates new readers. Shipped iOS 1.0.5 keeps opening every vault.
7. **The merge engine runs on every plan.** Plans only limit how many devices may have a vault unlocked at once (`vault_max_open_devices`).
8. **Free enforcement:** a server lease when signed in, an in-file owner claim otherwise. Offline never locks anyone out of their data. A displaced device locks the vault but keeps its open connections running.
9. **A master-password change is a key epoch.** The new key wraps the old one, so pending edits survive. Old password verifiers are removed from the file once bridged.
10. **Nothing overwrites a shared file that belongs to another vault or a newer format.** The shared file is replaced only by a publish of the same vault, or, when it is torn, after its bytes stayed unchanged for 2 minutes.
11. **No user file is moved or deleted without a click.** Copies of a vault are merged automatically only when that is causally safe. Everything else goes through a preview.
12. **The conflict queue is derived from the file state.** It cannot drift from the data, and every device shows the same queue.
13. **Deleted items keep a tombstone.** There is no automatic purge in format 1. "Delete permanently" erases values but keeps the causal record.
14. **Safety nets:** pre-merge snapshots with a targeted undo, a preview before merging any copy that could revert or delete data, and an "undecryptable value" state so no secret is dropped silently.

### 1.3 Architecture

```
 Device A: desktop (Electron main)                   Device B: iPhone (iOS 1.1+)
 +---------------------------------------+           +---------------------------------------+
 | Renderer / MCP / IPC                  |           | SwiftUI                               |
 |    | edits (ConduitVault)             |           |    | edits (VaultManager)             |
 |    v capture -> dot                   |           |    v capture -> dot                   |
 | Working copy W_A (private SQLite)     |           | Working copy W_B (GRDB)               |
 |  {syncRoot}/m-<hw>/<lineage>/w.conduit|           |  AppSupport/Vaults/<lineage>/w.conduit|
 |    ^ materialize                      |           |    ^ materialize                      |
 | SyncEngine: read S -> classify ->     |           | SyncEngine (Swift port): coordinated  |
 |  absorb legacy -> align epoch ->      |           |  read -> classify -> absorb -> merge  |
 |  merge -> commit W -> CAS publish     |           |  -> commit W -> CAS in-place publish  |
 |  (VACUUM INTO, tmp + rename)          |           |  (VACUUM INTO, coordinated write)     |
 |  + copy scanner, side-file rule       |           |  + NSFileVersion review [A]           |
 +------------------+--------------------+           +------------------+--------------------+
                    | whole-file bytes only                             | whole-file bytes only
                    v                                                   v
  +------------ User folder: iCloud Drive / OneDrive / Dropbox / Google Drive / SMB -----------+
  | Vault.conduit (WAL header, fully checkpointed, when we write it; schema_version = 10)       |
  |   content tables (what legacy apps read) + sync_* tables                                    |
  | Other copies ("Vault (conflicted copy).conduit", "Vault 2.conduit"): scanned, classified,   |
  |   merged only when safe or after a preview; never moved without a click                     |
  +---------------------------------------------------------------------------------------------+
        ^ legacy writers (iOS 1.0.5, desktop <= 0.17) edit content only; absorbed on next read

  Supabase (signed-in only, control plane): personal_vault_sessions + 5 RPCs + Realtime
     lease / take-over / plan limit / publish markers / busy + side-file flags.
     No vault content, no keys.
```

### 1.4 Why this transport

- **iOS can reach only the one file.** The document picker grants a file-only security scope, and write-back had to become an in-place write for that reason (`IOS/ConduitiOS/Core/Vault/VaultFileCoordinator.swift:120-136`; commit 7276d35) [V]. Anything iOS must see has to live inside the file or on Supabase.
- **The file is the medium the user already chose.** History inside the file works offline, signed out and on SMB shares. It puts no vault data on our servers (today `host`, `username`, `config` and `notes` are plaintext columns, `DESK/electron/services/vault/schema.ts:30-54`) [V]. Conflict copies become more replicas.
- **Cloud drives replace whole files, sometimes late, sometimes silently.** A state-based merge tolerates this. Any replica can merge with any other at any time, and a lost publish is republished from the working copy.

| Alternative | Why not |
|---|---|
| Supabase change log or relay as the Pro transport | Puts encrypted vault content on the server and needs sign-in. A second source of truth; offline-first gets harder. |
| Whole-file cloud backup as the transport | Last upload wins (`upsert: true`), 10 MiB cap (`DESK/electron/services/vault/cloud-sync.ts:15,678`) [V], needs sign-in. It stays a backup. |
| Sidecar journals or lock files | iOS cannot create or read sibling files. |
| SQLite triggers stored in the file | They would run inside legacy apps' transactions; a failure there breaks shipped apps. |
| Bump `schema_version` to 11 | iOS 1.0.5 throws `schemaMismatch` above 10 (`IOS/ConduitiOS/Core/Vault/VaultMigrations.swift:32,83-88`) [V]. |
| Snapshot three-way merge (stored BASE) | A silent cloud overwrite makes the snapshot a wrong ancestor, and the device then erases its own edit. Dots avoid this. |

---

## 2. Decisions

### 2.1 Decisions table

| Topic | Decision | Why (one line) |
|---|---|---|
| Causality model | HLC dots, version vector, pseudo dots with per-register memory | The only rule that was prototyped: `PROBES/register-sim.mjs`, 3 seeds x 3,000 runs, 0 failures, re-run this pass [V]. |
| Replica id lifetime | New random incarnation per app launch, plus an in-memory high-water check | A restored working copy can never reuse a dot (red team #1, #17). |
| Equal values inside the state | Never collapse them | Collapsing broke associativity and dropped writes (159 failures in 3,000 runs). |
| Deleted rows | Tombstones kept; no time-based purge in format 1 | Wall-clock purge broke the merge laws and lost edits (red team #2). |
| Candidate files (sandboxes, copies, pre-sync files) | Replica merge when the file has sync tables; otherwise a synthetic replica with its own dots, W's values provisional | ms-0 genesis dots were covered and silently dropped (red team #3). |
| Foreign `-wal` | Never applied automatically; publishing pauses until the user confirms old apps are closed | SQLite applies a mismatched WAL silently (`PROBES/walprobe/probe.cjs`) [V]; an idle 0.17 looks exactly like a crashed one (red team #12). |
| Shared file that fails checks | Split into unreadable (retry, then repair) and foreign (never overwrite) | A lineage or format mismatch caused an overwrite ping-pong (red team #6, #13, #26). |
| Password change | Key epoch with validated wraps; old verifiers removed once bridged | Pending edits survive; no offline oracle for old passwords (red team #21, #27, #34). |
| Capture of local edits | In-transaction hooks plus a full pass before every merge | A missed hook costs only attribution, never data. |
| Commit of a merge | Generation check; redo the join if W changed | A local edit during a merge was overwritten (red team #8). |
| Legacy detection | Per-row stored-bytes hash, then per-register value hash | Cheap; a cross-platform mismatch in the row hash only costs speed. |
| Legacy safety rules | Dropped config keys are kept; stale reverts become conflicts; deletes are held while old desktops have the file open | iOS 1.0.5 rebuilds config and writes stale editor state (red team #7, #10) [V]. |
| Conflict storage | Derived from `sync_reg`/`sync_sibling` | Cannot drift from data. |
| Cosmetic fields | Queued as an "Appearance" group with "Keep newest" preselected; `sort_order` resolves automatically | The brief says the user chooses. |
| Working-copy location | Machine-local root (LOCALAPPDATA on Windows), per-machine subfolder | Roaming profiles and redirected AppData would share or overwrite it (red team #15). |
| Free enforcement, signed in | Server lease with a lease id per acquire | A late heartbeat reactivated a released session (red team #31). |
| Free enforcement, not confirmed by server | Owner claims honored from every device, including the same account | Blocking the Supabase host gave unlimited Free use (red team #24). |
| Which vaults take a lease | Every vault; claims and working copies for shared vaults (decided by realpath) | A symlinked `default.conduit` bypassed the rule (red team #25). |
| Displacement | Soft lock: clear the vault key, keep open connections running | Closing every session on a phone lookup killed live work (red team #29). |
| Stale-file wait | Publish markers per device, scoped by file id, with "Open now" always and "Stop waiting" | A wiped phone or a second copy left a wait that never cleared (red team #30, #32). |
| Copies of the vault | Classify, merge only when safe, preview otherwise; never move files | User duplicates were merged and removed (red team #4, #14). |
| Cross-device copies | File id and location on every session; prompt when devices use different files | Two devices on two copies diverged forever (red team #9). |
| Lease table | New `personal_vault_sessions` | Prod `vault_locks` has a foreign key to `team_vaults` (critic A2) [V]. |
| iOS device id | Keychain `ThisDeviceOnly` | The UserDefaults id (`IOS/ConduitiOS/Core/Networking/IdentityKeyService.swift:73-80`) [V] is restored onto new phones. |
| Storage layout | Integer row handles, implicit default registers | Measured 1.94 to 2.40 MB at 2,000 entries versus 4.37 MB before (`PROBES/compactprobe.cjs`) [V]. |
| Profile hardening | Trigger guard on `user_profiles` | A column revoke breaks two verified client writes (section 9.2). |

### 2.2 Deviations from the default product decisions

- **The merge engine runs on Free too.** Free users still move between devices one after another. Late cloud delivery, iOS 1.0.5's blind write-back and a displaced device's final save all race. "Never lose data" cannot hold for Free without merging. Free still cannot have two devices open at once.
- **Conflict review works on every plan.** A downgrade must never strand pending conflicts.
- **Displacement locks the vault but keeps open connections running.** The default said "the previous device is locked". The vault is locked; terminals, RDP, VNC, web sessions and running commands continue. New vault reads are blocked. (Owner confirmation in 15.1.)
- **Free enforcement starts on desktop before iOS 1.1 ships.** iOS 1.0.5 can never be enforced. The wording excludes iOS until 1.1.
- **Publishing next to an old desktop's leftover `-wal`/`-shm` needs a one-time user confirmation.** There is no automatic 24-hour resume (red team #12).
- **Desktop 1.0 of the review panel (7.2, 7.3).** Notes and documents show every version in full (line breaks kept, scrollable) instead of a side-by-side diff. [Keep both] is offered for notes and documents only; for `private_key` and `totp_secret` the panel warns that the other versions are removed and suggests revealing and copying a key first.
- **A backup restore into a synced vault that is not open is refused (5.10).** The user opens and unlocks that vault first; the restore then runs as a preview, rollback or new vault. A whole-file replace would be merged away by the working copy at the next unlock.
- **Cached Pro may raise the offline limit for up to 7 days.** The red team asked that cached values never raise the limit. A Pro user behind a firewall that blocks Supabase would otherwise lose multi-device use. Editing `settings.json` is a client modification, which is an accepted limit (6.13).

### 2.3 Review history

**Judge fixes kept from the synthesis:** no in-place `wal_checkpoint` on the shared file; `sync_row.materialized` with cascade rule H; stale-key legacy secrets become undecryptable siblings; signed-out Free gets real displacement; full SQL for the RPCs; only hashes and ids need byte-exact parity between TS and Swift; copy detection; cosmetic fields queued; trigger guard instead of a column revoke.

**Red-team changes** (full plain-language list in the design session's disposition file):

| # | Finding (short) | Change | Section |
|---|---|---|---|
| 1 | Restored W reuses old dots | Per-launch incarnation, in-memory high-water check, empty-register guard | 3.1, 4.1, 4.5 |
| 2 | Wall-clock GC and straggler rule break merge laws | No time-based GC; tombstones kept; redaction for "Delete permanently" | 4.7 |
| 3 | Candidate genesis dots covered and dropped | Replica and synthetic candidates | 4.9 |
| 4, 14 | Pattern-named user copies merged and moved | Copy classification; review for anything that can revert or delete; never move | 5.8 |
| 5 | Undo rolled back everything since the snapshot | Targeted undo of the merge's own diff, with preview | 5.10 |
| 6, 13, 26 | Foreign file treated as torn and overwritten | Unreadable versus foreign; forks write new files; salt mismatch goes to the legacy password path | 5.2, 5.9, 4.8 |
| 7 | iOS 1.0.5 stale editor writes absorbed as authoritative | Drop rule, stale-revert rule, iOS 1.0.6 patch | 4.3, 10.1 |
| 8 | Merge commit overwrote a concurrent local edit | Generation check and re-join | 5.6 |
| 9 | Same vault bound to different files on two devices | File id, location, divergence prompt | 5.8 |
| 10 | Stale WAL folded by iOS 1.0.5 absorbed as deletes | Hold rule plus server side-file flag | 4.3, 5.5 |
| 11 | Legacy delete always lost to a legacy edit | Delete time from the observed file time | 4.3 |
| 12 | 24-hour leftover rule publishes over an idle live 0.17 | User confirmation; optional 0.17.x patch | 5.5, 11.4 |
| 15, 28 | Roaming AppData and cloned data folders | Machine-local root, per-machine folder, Linux machine-id, session nonce | 3.2, 3.1, 6 |
| 16 | Turning Labs off strands edits | Block the toggle, export, warn at start | 5.11 |
| 17 | Cloned machine shares a replica id | Per-launch incarnation; server session nonce | 3.1, 9.5 |
| 18 | Genesis re-run on pre-sync files resurrects rows | G2 baseline absorb, G3 genesis adoption, legacy-time rank | 4.4 |
| 19 | First iOS 1.1 launch floods stale conflicts | Replica absorb of the sandbox; newer-only filter | 4.9, 10.4 |
| 20 | Auto-rebind during a OneDrive rename dance | 30 s debounce; never auto-rebind to conflict names | 5.9 |
| 21, 27 | Old verifiers and pids leak old secrets | Epoch-id key check, redaction, keyed pids, ciphertext-based secret pids, "Delete permanently" | 3.6, 4.7, 4.8 |
| 22 | Older apps never pull a publish with an old mtime | mtime bump on publish | 5.3 |
| 23 | Sync overhead pushes vaults past 10 MiB | Compact layout, measured | 3.3, 3.7 |
| 24 | Blocking Supabase gives unlimited Free | Claims honored when unconfirmed; cache sanity; packaged builds ignore `CONDUIT_ENV` | 6.8 |
| 25 | App-data exemption bypass | Lease for all vaults; realpath decides shared | 6.1, 3.2 |
| 29 | Displacement kills live work | Soft lock, busy reporting | 6.6 |
| 30 | Stale `written_vv` never clears | Abandon, file-id scoping, Open now always | 6.11 |
| 31 | Heartbeat after release reactivates | Lease id; heartbeat never reactivates | 9.5 |
| 32 | `written_vv` size cap breaks the lease | One publish-marker entry per session; SQL errors are "unconfirmed" | 6.11, 9.4 |
| 33 | Device rows merged by wall clock | Device rows are registers with dots | 3.5 |
| 34 | Epoch wraps merged unchecked | Validated union set with explicit target | 4.8 |
| 35 | Row hash could cover plaintext secrets | Row hash over stored bytes only; golden vector | 3.6 |

---

## 3. Data model

### 3.1 Identities

| Id | Definition | Stored | Notes |
|---|---|---|---|
| `lineage_id` | Legacy file: `UUIDv5(NS_CONDUIT, "conduit-lineage:" + vault_meta.salt)` at first genesis. New vault: random UUIDv4. | `sync_state.lineage_id` | Two devices migrating the same legacy file compute the same id. A pre-sync file at a device's bound path is identified by the binding, not by re-deriving from the salt, because a legacy password change changes the salt (red team #26). |
| `genesis_id` | SHA-256 of the pre-sync file bytes the first genesis ran on; random for new vaults | `sync_state.genesis_id` | States with different genesis ids never merge directly (4.4 G3). |
| `device_uuid` | Random UUIDv4 per install | Desktop `{syncRoot}/m-<hw8>/device.json` `{device_uuid, hw_hint}`. iOS Keychain `conduit.sync.device`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. | Regenerated when `hw_hint` differs. `hw_hint` = SHA-256 of IOPlatformUUID (macOS), MachineGuid (Windows), `/etc/machine-id` or `/var/lib/dbus/machine-id` (Linux, new: `fingerprint.ts` has no Linux branch and falls back to the hostname, `DESK/electron/services/auth/fingerprint.ts:73-90`) [V]. If none, a random id in `{syncRoot}/machine.json`. Local only. Also the server `device_id`. |
| `session_nonce` | Random UUIDv4 per app launch, memory only | Server session row | Tells two running copies with the same `device_uuid` apart (cloned machine, copied data folder). |
| `incarnation`, `dev` | `incarnation` = random 128 bits, new at the first open of a lineage in each app launch and whenever the high-water check fails (4.1). `dev` = first 48 bits of `SHA-256(device_uuid ‖ lineage_id ‖ incarnation)`; 0 is reserved (0 maps to 1). | `local.json` (current); `sync_dev` (all devs, replicated) | Dots are never reused: a restore needs a new launch (new incarnation), or replaces W under a running process, which the in-memory check catches. |
| `file_id` | Random UUIDv4 minted by the first device that binds a shared path; later devices binding the same file adopt it; re-minted when one device sees the same `file_id` at a second path | `local.json` binding; each publish writes it into `sync_state.file_id` | Per file, never merged. Used to tell copies apart (5.8). |
| `vault_meta.vault_id` | Unchanged meaning (cloud backup, `DESK/electron/services/vault/vault.ts:1054-1062`) [V]. A legacy file without one gets `UUIDv5(lineage_id, "vault-id")` at genesis. | content | Auto register |
| `account_hint` | `hex(trunc16(SHA-256("conduit-acct-v1" ‖ lineage_id ‖ user_id)))`, or NULL when signed out | device register | Independent of the epoch |

### 3.2 Where local state lives

| Platform | `syncRoot` | Why |
|---|---|---|
| macOS | `~/Library/Application Support/<app>/<conduit or conduit-dev>/sync` | Today's data folder; not roamed |
| Windows | `%LOCALAPPDATA%\Conduit\<conduit or conduit-dev>\sync` | The data folder is under `app.getPath('appData')` (`DESK/electron/app-identity.ts:17`, `DESK/electron/services/env-config.ts` `getDataDir`) [V], which is Roaming AppData on Windows [A: Electron docs]. Roaming profiles and folder redirection would share or overwrite it. |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/conduit/<env>/sync` | |
| iOS | `Application Support/Vaults/` | In device backup; per-launch incarnation makes a restore safe |

- Under `syncRoot`, `m-<first 8 hex of hw_hint>/` holds `device.json` and one folder per lineage. Two machines that share a home or profile never share a working copy.
- If `isNetworkPath(realpath(syncRoot))` is true, W uses `journal_mode=DELETE` (no shared-memory WAL over a network share) and a one-time warning shows.
- `settings.json`, backups and `default.conduit` stay where they are today.

**A vault is "shared"** unless its `realpath` is inside the machine's resolved data folder, on a local volume, and the path is not a symlink to elsewhere. Shared vaults get a working copy, owner claims and the copy scanner. Every vault, shared or private, takes the server lease (6.1).

**Per-lineage folder** `{syncRoot}/m-<hw8>/<lineage>/`:
- `w.conduit`: the working copy (WAL mode unless the root is on a network path)
- `local.json`: binding `{shared_path, realpath, file_id}`, current `dev` and `incarnation`, `last_merged_sha256`, `last_published {sha256, marker_dot}`, `pending_publish`, `side_files {tuples, confirmed_at}`, `side_files_confirmed_at` (5.5 server flag), `held_legacy[]`, `snoozed[]`, `last_limit {value, at}`, `ignored_copies[]` (by SHA-256), `abandoned_waits[]`, `notices[]`, `drop_staged_after_publish` (4.8). Written atomically (tmp + rename) and validated on read; a corrupt file is moved to `parked/` and rebuilt from W.
- `genesis.conduit`: the exact pre-sync bytes of the first genesis on this device (kept 180 days, or until a password change on this device; baseline for 4.4 G2)
- `incoming/`, `snapshots/` (each with a `diff.json`), `quarantine/`, `parked/`, `exports/`, `sidefiles-<ts>/`

### 3.3 On-disk data model (DDL inside `.conduit`)

**Rules:** every statement is idempotent; no foreign keys point at content tables; no triggers; `schema_version` is not touched; the same DDL runs on desktop (`DESK/electron/services/sync/schema.ts`) and iOS (`ConduitiOS/Core/Sync/SyncSchema.swift`).

```sql
INSERT OR IGNORE INTO vault_meta(key, value) VALUES ('sync_format', '1');

-- Fix: fresh desktop vaults lack this table. database.ts:80-83 applies only CREATE_SCHEMA,
-- and the table exists only in migration v9 (migrations.ts:191-205) [V]. Same DDL as v9 and iOS.
CREATE TABLE IF NOT EXISTS password_history (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  username TEXT, password_encrypted BLOB, changed_at TEXT NOT NULL, changed_by TEXT);
CREATE INDEX IF NOT EXISTS idx_password_history_entry ON password_history(entry_id, changed_at DESC);

-- lineage_id, genesis_id, created_ms: replicated constants.
-- file_id: per file, written by the publisher, never merged.
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sync_vv (             -- version vector
  dev INTEGER PRIMARY KEY, hlc_ms INTEGER NOT NULL, hlc_c INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sync_dev (            -- which install minted each dev; rows never change; merge = union
  dev INTEGER PRIMARY KEY, device_uuid TEXT NOT NULL, started_ms INTEGER NOT NULL);

-- Compact per-file handle for each synced row. rid values are local to one file:
-- merge always joins on (tbl, row_id), never on rid.
CREATE TABLE IF NOT EXISTS sync_rowkey (
  rid INTEGER PRIMARY KEY, tbl INTEGER NOT NULL, row_id TEXT NOT NULL, UNIQUE (tbl, row_id));

-- Provisional (winning) sibling of every explicit register, plus the register's pseudo memory.
-- A register of a known row that has no sync_reg row is IMPLICIT (3.4).
CREATE TABLE IF NOT EXISTS sync_reg (
  rid INTEGER NOT NULL,
  reg TEXT NOT NULL,           -- register name (3.5)
  dev INTEGER NOT NULL, hlc_ms INTEGER NOT NULL, hlc_c INTEGER NOT NULL,
  pid BLOB,                    -- 16 bytes when dev = 0, else NULL
  lt INTEGER NOT NULL DEFAULT 0,  -- legacy time hint (ms) of a pseudo sibling; rank only
  vhash BLOB NOT NULL,         -- 16 bytes, hash of the provisional LOGICAL value (3.6); zeroed when redacted
  prev_vhash BLOB,             -- 8 bytes: value this app provisional replaced (stale-revert rule, 4.3)
  flags INTEGER NOT NULL DEFAULT 0,  -- bit 1: redacted
  pmem_ms INTEGER,             -- NULL = derived: {ms, {pid}} of the provisional if pseudo, else empty
  pmem_ids BLOB,               -- concatenated 16-byte pids seen at pmem_ms
  mat TEXT,                    -- canonical MATERIALIZED value when it differs from the logical one
  PRIMARY KEY (rid, reg)) WITHOUT ROWID;

-- Every other live sibling (conflicts, equal-valued concurrent writes, undecryptable values).
CREATE TABLE IF NOT EXISTS sync_sibling (
  rid INTEGER NOT NULL, reg TEXT NOT NULL,
  dev INTEGER NOT NULL, hlc_ms INTEGER NOT NULL, hlc_c INTEGER NOT NULL,
  pid BLOB NOT NULL DEFAULT x'',
  lt INTEGER NOT NULL DEFAULT 0,
  vhash BLOB NOT NULL,
  flags INTEGER NOT NULL DEFAULT 0,   -- bit 0: undecryptable secret; bit 1: redacted
  value BLOB,                         -- canonical value; secrets = ciphertext under the current epoch
  PRIMARY KEY (rid, reg, dev, hlc_ms, hlc_c, pid)) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sync_row (            -- change-detection cache
  rid INTEGER PRIMARY KEY,
  materialized INTEGER NOT NULL DEFAULT 0,       -- 1 = a content row is expected to exist
  raw_hash BLOB);                                -- 16 bytes over STORED column bytes (3.6)

CREATE TABLE IF NOT EXISTS sync_grave (          -- provisional values of dead rows (secrets stay ciphertext)
  rid INTEGER PRIMARY KEY,
  row_json TEXT,                                 -- NULL once redacted
  died_ms INTEGER NOT NULL, died_c INTEGER NOT NULL, died_dev INTEGER NOT NULL,
  redacted INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS sync_key_epoch (
  epoch_id TEXT PRIMARY KEY,   -- hex(trunc16(HMAC-SHA256(K_epoch, "conduit-epoch-id-v1"))): a key check value
  parent_epoch TEXT,
  salt TEXT,                   -- NULL once redacted (4.8)
  verification TEXT,           -- NULL once redacted (4.8)
  created_ms INTEGER NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sync_key_wrap (       -- merge = union; validated on use (4.8)
  epoch_id TEXT NOT NULL,      -- wrapping (newer) epoch
  target_epoch TEXT NOT NULL,  -- epoch whose key is wrapped
  wrap BLOB NOT NULL,          -- AES-256-GCM(K_epoch, K_target): nonce12 ‖ ct ‖ tag16, AAD = epoch_id ‖ 0x1f ‖ target_epoch
  PRIMARY KEY (epoch_id, target_epoch, wrap)) WITHOUT ROWID;
```

- The current key epoch, the Free owner claim, dismissed suggestions and every device's presence row are registers in table 9 (3.5), so they use the same merge machinery.
- The unused `vault_sync_meta` and `vault_sync_conflicts` tables (`DESK/electron/services/vault/migrations.ts:46-74`) [V] are left alone and ignored.

### 3.4 Implicit registers

- A register of a row that exists in `sync_rowkey` but has no `sync_reg` row is **implicit**. It means exactly one sibling: an implicit genesis sibling with the catalog default value (NULL, 0 or absent), dot `(dev 0, ms 0, c 0)`, `pid` = 16 zero bytes, `lt` = 0, `pmem = {0, {zero pid}}`.
- Genesis writes explicit registers only for non-default values. An app create writes explicit registers only for non-default values. Every other register stays implicit.
- A register of a row that is not in `sync_rowkey` at all is an **empty** sibling set, not implicit.
- The zero pid is the same on every device and needs no key, so implicit siblings compare equal everywhere.

### 3.5 Register catalog

- **Prompt:** different concurrent values go to the user queue.
- **Group A:** prompt class, shown as one "Appearance" item per entry with "Keep newest" preselected.
- **Auto:** the provisional (highest-rank) value is kept silently. Siblings stay in the file until the next write.

| Table (tbl) | Register | Source column(s) | Class | Notes |
|---|---|---|---|---|
| entries (1) | `_life` | whether the row exists | prompt | `live` or `dead` (4.7) |
| entries | `name`, `entry_type`, `host`, `port`, `username`, `domain`, `credential_type`, `notes` | same | prompt | An empty string equals NULL for optional text |
| entries | `container` | `folder_id` + `parent_entry_id` | prompt | Value `r`, `f:<id>` or `e:<id>`. If a legacy row has both set, `e:` wins, matching `deleteEntry` (`DESK/electron/services/vault/vault.ts:604-605`) [V]. |
| entries | `credential_id` | same | prompt | A reference (re-asserts its target, 4.2) |
| entries | `password`, `private_key`, `totp_secret` | `*_encrypted` | prompt, secret | Hashed over the plaintext with a key (3.6) |
| entries | `config.<key>` (one per top-level key) | `config` JSON | prompt | RFC 8785 JCS. A removed key is "absent". Documents use `config.content` and offer [Keep both]. |
| entries | `tag:<value>` | `tags` JSON array | group A | Set semantics: present or absent |
| entries | `icon`, `color`, `is_favorite` | same | group A | |
| entries | `sort_order`, `created_at` | same | auto | |
| entries | (none) | `updated_at` | derived | Not a register (4.6) |
| folders (2) | `_life`, `name`, `container` (`parent_id`: `r` or `f:<id>`) | same | prompt | |
| folders | `icon`, `color` | same | group A | |
| folders | `sort_order`, `created_at` | same | auto | |
| password_history (3) | `_life`, `entry_id`, `username`, `password` (secret), `changed_at`, `changed_by` | same | auto | Write-once rows with unique ids |
| vault_meta (4) | `vault_id`, `cloud_sync_enabled` | row `value` | auto | `salt`, `verification` and `key_source` come from the epoch. `schema_version`, `sync_format` and `team_vault_id` are not synced. |
| _sync (9) | `key/epoch` | current key epoch | special (4.8) | |
| _sync | `owner/owner` | Free owner claim `{"a": account_hint or null, "d": device_uuid}` | auto | Section 6.7 |
| _sync | `dismiss/<hash>` | dismissed suggestions | auto | For example the duplicate-folder suggestion |
| _sync | `device/<device_uuid>` | presence row, canonical JSON: `platform`, `name`, `app_version`, `first_seen_ms`, `last_active_ms`, `session_open`, `session_since_ms`, `account_hint`, `file_hint {file_id, location, file_name}`, `side_files_seen_ms` | auto | One writer per install, so newer dots always replace older ones. Merged by dots, never by wall clock (red team #33). Written at unlock, lock, every publish (the publish marker, 6.11) and when a field changes. |

Columns outside this catalog are not synced. Adding a content column requires `sync_format 2`.

### 3.6 Canonical values, hashes and ids

- **`canon(v)`:**

  | Value | Encoding |
  |---|---|
  | NULL, or empty optional text | `0x00` |
  | integer or boolean | `0x01` + ASCII decimal (`"1"` stored as text in an INTEGER column becomes 1; NULL `sort_order`/`is_favorite` become 0) |
  | text | `0x02` + UTF-8 (no Unicode normalization) |
  | secret | `0x03` + UTF-8 plaintext (used only inside keyed hashes) |
  | JSON | `0x04` + RFC 8785 JCS |
  | container | `0x05` + `r`, `f:<id>` or `e:<id>` |
  | timestamp (`created_at`, `changed_at`) | `0x07` + ISO-8601 UTC with milliseconds. Parsed from ISO or GRDB `YYYY-MM-DD HH:MM:SS(.SSS)`; unparseable text falls back to `0x02` [A: GRDB default format] |

- **Keys.** `K_sync = HKDF-SHA256(ikm = K_epoch, salt = UTF-8(lineage_id), info = "conduit-sync-vhash-v1", L = 32)`. `K_pid` is the same with `info = "conduit-sync-pid-v1"`.
- **`vhash`, non-secret:** `trunc16(SHA-256("cvh1" ‖ 0x1f ‖ tbl ‖ 0x1f ‖ row_id ‖ 0x1f ‖ reg ‖ 0x1f ‖ canon(v)))`. Unkeyed on purpose: these values are already plaintext in the file, and an unkeyed hash does not depend on the epoch, so a device that knows only a new password still absorbs non-secret legacy edits precisely.
- **`vhash`, secret:** `trunc16(HMAC-SHA256(K_sync, same message))`. Including `row_id` hides whether two entries share a password. Old desktop re-encrypts every secret on every update with a random nonce (`DESK/electron/services/vault/crypto.ts:45-73`) [V], so only a plaintext hash can tell "unchanged".
- **Undecryptable secret sibling:** `vhash = trunc16(SHA-256("cvhx" ‖ ciphertext))`, flag bit 0.
- **`pid` (pseudo sibling id):** `trunc16(HMAC-SHA256(K_pid(E_abs), "cpid1" ‖ 0x1f ‖ tbl ‖ 0x1f ‖ row_id ‖ 0x1f ‖ reg ‖ 0x1f ‖ vref ‖ 0x1f ‖ base_ref))`.
  - `E_abs` is the epoch of the file being absorbed. All devices absorbing the same bytes use the same epoch, so they compute the same pid.
  - `vref` is the unkeyed `vhash` for non-secret registers, and `SHA-256(stored ciphertext)` for secrets. No plaintext-derived material ever reaches a secret's pid (red team #27).
  - Keying the pid means a superseded value's pid, which stays in pseudo memory, cannot be tested against guesses without that epoch's key.
  - The implicit genesis sibling's pid is 16 zero bytes.
- **`prev_vhash`:** first 8 bytes of the `vhash` of the value an app provisional replaced. Set only on app dots.
- **`raw_hash`:** `trunc16(SHA-256("crow1" ‖ for each catalog column in order: tag ‖ length ‖ STORED bytes))`, excluding `updated_at`. Secrets enter as the stored ciphertext bytes. It is never computed over `canon()` values or plaintext (red team #35). Re-encrypting the same value changes `raw_hash`; the per-register compare then reports no change.
- **Must match byte for byte across TS and Swift** (golden vectors, 13.1): `canon`, both `vhash` forms, `pid`, `raw_hash`, `dev`, `lineage_id`, `genesis_id`, `account_hint`, `epoch_id`, the HKDF outputs. A `raw_hash` mismatch would cost only speed, but it is still a CI gate.

### 3.7 Size

Measured with synthetic vaults of 2,000 connection entries (10 non-default registers each), bundled SQLite 3.53.4 [V, `PROBES/compactprobe.cjs`, `PROBES/vacprobe.cjs`]:

| Layout | Whole file | After deflate |
|---|---|---|
| Content only | 0.69 MB | not measured |
| Earlier layout (TEXT keys, every register stored) | 4.37 MB | 1.44 MB |
| This layout, fresh genesis | 1.94 MB (971 bytes per entry) | 0.92 MB |
| This layout, every register app-edited (worst case) | 2.40 MB (1,202 bytes per entry) | 1.54 MB |

- So 10 MiB is reached at roughly 8,000 to 10,000 entries, versus about 4,700 before.
- **Version vector growth:** one entry per app launch per device (about 30 bytes). Three devices launching twice a day add about 65 KB a year. Compaction is reserved for `sync_format 2`.
- **Tombstones:** a deleted row keeps its registers (about 0.6 KB).
- **Cloud backup** deflates before encrypting only when the file exceeds 10 MiB, as blob version `0x02`, which iOS 1.1 and desktop 0.18+ read. Below 10 MiB it stays `0x01`, so iOS 1.0.5 and desktop 0.17 can still restore it. Desktop 0.17 cannot upload a vault above 10 MiB (`cloud-sync.ts:15,678`) [V]; release notes and the Backup tab say so.
- `sync_format 2` (packed per-row blobs, version-vector compaction and GC under causal stability) is reserved if telemetry shows p95 above 5 MB.

---

## 4. Algorithms

### 4.1 Clocks, dots and rank

- **HLC per replica:** `(ms, c)`, `ms` = wall-clock milliseconds, `c` = 0..65535.
  - **Tick:** `ms' = max(wall, ms)`; `c' = (ms' == ms) ? c + 1 : 0`. If `c` would pass 65535, `ms' = ms + 1, c' = 0`.
  - **Receive** after each merge: `hlc = max(hlc, max app dot in the merged state)`, ignoring dots from other installs with `ms > wall + 24h`. Stamps are never rewritten.
  - **Start:** `hlc = max(wall, every W.vv[d] where sync_dev maps d to this device_uuid, the same over S once read)`. Including this install's own past dots, even future-dated ones, keeps its presence register monotone.
- **App dot:** `(dev > 0, ms, c)`. One user operation uses one dot for every register it writes. `vv[self] = dot`.
- **Version vector** `sync_vv`: pointwise maximum of every app dot absorbed. Merges always take whole states, so `vv[d] >= x` means "has seen every write from `d` up to `x`".
- **Pseudo dot** (legacy and genesis values): `(dev 0, ms, c 0, pid)`, with a legacy time hint `lt`.
- **Pseudo memory `pmem(k)`:** `{ms, ids}` per register; which pseudo siblings this state has seen.
- **Rank** (provisional value only): `(ms, c, dev, lt, pid)` compared left to right, largest wins. `lt` breaks the tie between genesis siblings (all `ms = 0`) in favor of the newest legacy row, so the provisional value is never effectively random (red team #18). Undecryptable and redacted siblings are never provisional.
- **High-water check (red team #1, #17).** The process keeps `hwm` = the last dot it stamped, in memory only.
  - At every unlock and before every capture transaction: if `W.vv[current dev] < hwm`, W was replaced under the running process. Start a new incarnation.
  - Before every merge: if `S.vv[current dev] > W.vv[current dev]`, or S holds a sibling with the current dev that W lacks, start a new incarnation and re-stamp W's own siblings from the old dev that S lacks under a new dot (same value). With random per-launch incarnations this should only happen through a 2^-48 collision or a bug; it is a guard, and it reports `sync.dev_collision`.

Causality comes from `vv` and `pmem`, never from timestamps. Clock skew changes only rank.

### 4.2 Capture of local edits

One routine, `capture(X, attribution)`. X is W or an in-memory copy of a file being absorbed.

1. **Row pass.** For each content row: if `sync_row.materialized = 1` and `raw_hash` matches, skip it. Otherwise compare each register's `canon` hash (decrypting secrets with X's epoch key, or applying 4.8's stale-key rule) with the expected hash (`mat` when set, else `sync_reg.vhash`, else the implicit default). A difference, or a missing register, is a change.
2. **Insert.** A content row with no `_life` register: every non-default register changes, plus `_life = live`.
3. **Delete.** A row with `materialized = 1` and no content row: `_life = dead`.
   - **Cascade rule H:** a `password_history` row that vanished while its entry also died (or was already dead or not materialized) in the same capture is not recorded as deleted. Its visibility follows its entry (4.6), so reviving the entry brings its history back.
   - Desktop's recursive folder delete and child promotion (`DESK/electron/services/vault/database.ts:187-238`, `vault.ts:591-622`) [V] and iOS's `ON DELETE SET NULL` folder delete (`IOS/ConduitiOS/Core/Vault/VaultDatabase.swift:114,143-144,156`) [V] show up as ordinary register changes in the same capture.
4. **Re-assertion rule R.** Every captured operation also writes `_life = live` on each row it changed, that row's container chain as materialized after the change, and the rows it references (`credential_id` target; `entry_id` for history). A re-assertion replaces only earlier `live` siblings and keeps any `dead` sibling it has seen, so an open delete conflict stays visible.
5. **Local attribution** `Local(dot, interactive)`: one new app dot for the whole operation.
   - An interactive edit in the conflict-aware editor, a resolution, an explicit delete or a "Keep" choice replaces all siblings of each changed register.
   - Any other local write (MCP, import, autofill-selector save, rollback) replaces only the provisional sibling it saw, so an open conflict stays open.
   - Each new app provisional records `prev_vhash` = the first 8 bytes of the replaced provisional's `vhash`.
6. **When it runs.** Inside the same SQLite transaction as each mutation (desktop `ConduitVault` mutators; iOS `VaultManager` mutators, `IOS/ConduitiOS/Core/Vault/VaultManager.swift:331-442`), which also bumps `W.gen` (5.6). A full pass runs before every merge and publish to catch writes that skip hooks: `vault_meta` writes (`vault.ts:1054-1074`), `rekey`/`changePassword`, importers, MCP (desktop-vault-lifecycle section 6) [V]. A missed hook costs only attribution quality.

### 4.3 Capture of legacy edits

`capture(X, Legacy(file))` runs when a staged file's content differs from its own sync tables. For each changed register `k` with new value `v`, let `w` = X's provisional sibling of `k` (what the legacy app saw):

1. **Drop rule (red team #7).** Not applied, and a local notice is recorded, when:
   - `k` is `config.<key>` and `v` is absent, `[]`, `{}` or `""` while `w`'s value is not empty; or
   - `k` is a document's `config.content` and `v` is absent or empty.

   iOS 1.0.5 rebuilds `config` from scratch on every save: documents and credentials get `{}`, and RDP always gets `sharedFolders: []` (`IOS/ConduitiOS/Features/Vault/EntryEditorView.swift:651-712`) [V]. The notice offers [Remove it everywhere], an interactive write. S is marked for a content-repair publish so older apps see the kept value again.
2. **Hold rule (red team #10).** While side files are present (5.5), or the server reports side files for this lineage within 2 hours, legacy **deletes** and **stale reverts** are not applied. They go to `held_legacy` and show as one review item: "While an older Conduit had this vault open, it deleted 2 items and changed 1 back to an earlier value." [Apply these changes] [Keep my versions].
3. **Stale-revert rule (red team #7).** If `w` is an app sibling and `prev_vhash(w)` equals the first 8 bytes of `vhash(v)`, the legacy app most likely wrote back an editor snapshot taken before `w`. Create the pseudo sibling but keep `w`, which makes a conflict ("An older Conduit app changed this back to an earlier value"). iOS 1.0.5 builds the saved row from the entry captured when the editor opened, including `passwordEncrypted` and other secrets (`EntryEditorView.swift:598-623`) [V], and its 5-second poll can pull newer data under an open editor.
4. **Otherwise** the new pseudo sibling `p = (dev 0, ms, pid(k, vref(v), base_ref), lt)` removes `w` and every older pseudo sibling. Concurrent app siblings stay.
   - `base_ref` = `0x01 ‖ dev ‖ ms ‖ c` of `w`; `0x02 ‖ pid` if `w` is pseudo; `0x00` if none.
   - **Edits:** `lt = parseLegacyTime(row.updated_at)` (0 if unparseable); `ms = max(lt, pmem_ms(k) + 1)`.
   - **Deletes and rowless registers** (`vault_meta`, `_sync`): `ms = lt = max(pmem_ms(k) + 1, observed mtime of the staged file, clamped to now + 24h)`. A legacy delete then follows the legacy clock like an edit instead of always losing (red team #11).
   - `pmem(k) = join(pmem(k), {ms, {pid}})`. At most one new pseudo sibling per register per absorption. Re-assertions use the largest `ms` among contributing rows.

**Documented weakenings:** two legacy apps editing the same field resolve by the legacy clock (today's behavior); two identical legacy edits count as one; a legitimate removal of a config key or emptying of a document by an older app is kept back with a notice; a genuine revert to an earlier value from an older app shows as a conflict.

### 4.4 Genesis and pre-sync files

**G1: first genesis** (no W for this lineage on this device, S has no sync tables).
- If signed in and the server's sessions for this lineage show any publish marker, wait up to 2 minutes for that synced file ("Getting the synced vault from MacBook...") with [Continue anyway]. This avoids most G3 cases.
- Every non-default register gets a pseudo sibling: `ms 0, c 0, lt = parsed row updated_at, base_ref 0x00`, keyed pid, `pmem = {0, {pid}}`. Default registers stay implicit. `vv = {}`.
- Epoch `E0` with `epoch_id = KCV(K0)`, no parent. `genesis_id = SHA-256(file bytes)`. A missing `vault_id` becomes `UUIDv5(lineage_id, "vault-id")`.
- Two devices migrating the same bytes produce identical states.
- The pre-sync bytes are kept as `genesis.conduit` for 180 days.

**G2: S is pre-sync but W exists** (an older app wrote a pre-sync copy over the shared file, which happens when iOS 1.0.5 writes back a sandbox copied before the first genesis):
1. **Key check.** Try S's `vault_meta.verification` token with W's current key and every key reachable through valid wraps. If one opens it, S is simply a file under that (older) epoch; continue. If none does, this is a legacy password change: run 4.8's legacy flow first. Never treat it as a different vault (red team #26).
2. **Baseline absorb** when `genesis.conduit` exists and its SHA-256 equals `W.genesis_id`: build `X = genesis(G)` in memory, replace its content with S's content, and run `capture(X, Legacy(S))` with a staleness filter:
   - skip rows whose S `updated_at` is older than the same row in G (the file predates the baseline);
   - count a G row missing from S as a delete only if the newest `updated_at` in S is at or after that row's G `created_at`.

   Then merge W with the result. Changes made after genesis on both sides become ordinary conflicts.
3. **No baseline on this device:** treat S as a synthetic candidate (4.9) with review, labeled "A copy saved by an older Conduit app". Deletes are never inferred; rows missing from S are listed with [Delete them too].
4. Publish afterwards (S lacks sync tables), unless publishing is blocked.

A genesis never runs on a pre-sync file once W exists. This removes the silent resurrection of deleted rows (red team #18).

**G3: S has sync tables but a different `genesis_id`** (two devices migrated different pre-sync versions):
1. Split W: `W_g` = registers whose every sibling is a genesis pseudo sibling of W's genesis, and rows present only through such registers. `W_rest` = everything else (app dots, legacy pseudo siblings with `ms > 0`, graves, epochs, devices).
2. `M = merge(W_rest, S1)`; `M.genesis_id = S.genesis_id`.
3. Offer `W_g` as a synthetic candidate against M, filtered to rows whose `lt` is newer than M's row, or rows absent from M: "Differences between two copies saved by older Conduit apps (N)".
4. The shared file's genesis always wins. Conflict copies and candidates with another genesis go through step 3 only.

### 4.5 Merge

```
covered(X, k, s):
  if s.dev == 0: pm = X.pmem(k); return pm && (pm.ms > s.ms || (pm.ms == s.ms && s.pid in pm.ids))
  e = X.vv[s.dev]; return e && (e.ms, e.c) >= (s.ms, s.c)

identity(s) = s.dev == 0 ? ("p", s.ms, s.pid) : ("a", s.dev, s.ms, s.c)

sibs(X, k): explicit siblings; the implicit sibling (3.4) if the row is known and k has no sync_reg row;
            the empty set if the row is unknown

mergeRegister(A, B, k):
  a = sibs(A, k); b = sibs(B, k)
  keep = { s in a : identity(s) in ids(b) or not covered(B, k, s) }
       ∪ { s in b : identity(s) not in ids(a) and not covered(A, k, s) }
  if keep is empty and (a ∪ b) is not empty:        // only after an invariant violation
    keep = a ∪ b; report sync.invariant_violation     // never materialize an empty register
  for an identity present on both sides: redacted wins (value NULL, vhash zeroed)
  return { sibs: keep, pmem: joinPmem(A.pmem(k), B.pmem(k)) }   // larger ms wins; equal ms -> union of ids

merge(A, B):   // preconditions: same lineage, same genesis_id, same current epoch (4.8 aligns first)
  vv       = pointwise max(A.vv, B.vv)
  devs     = union(A.sync_dev, B.sync_dev)
  rows     = union of (tbl, row_id)
  regs     = { k: mergeRegister(A, B, k) for k in keys(A) ∪ keys(B) }
  epochs   = union by epoch_id; per field, salt and verification: NULL wins (redaction)
  wraps    = union
  graves   = per row: redacted wins, else the one with the larger died dot
  return materialize(vv, devs, regs, epochs, wraps, graves)   // 4.6
```

- **Values.** A kept sibling's value comes from whichever replica carries it: the content table for its provisional sibling, `sync_sibling.value` otherwise, `sync_grave` for a dead row's provisional values, or the catalog default for the implicit sibling. One identity always has one value.
- **Provisional value:** `_life` is `live` if any sibling is `live` (keeps data visible), using the highest-rank `live` sibling. Otherwise the highest-rank decryptable, unredacted sibling.
- **Conflict** (prompt and group A registers): more than one distinct `vhash` among decryptable siblings; any undecryptable sibling; or `_life` holding both `live` and `dead`.
- **No normalization inside the state.** Equal-valued siblings are all kept; only the UI and the conflict test compare values.
- **Invariants** kept by capture and merge: I1, every app sibling in X is covered by `X.vv`; I2, every pseudo sibling is covered by `X.pmem`. So "dropped because covered and absent" always means "seen and superseded". Dot reuse was the one way to break I1; per-launch incarnations remove it.
- **Evidence.** `PROBES/register-sim.mjs` models this single-register rule, including legacy partial replacement and genesis from different versions, and checks commutativity, associativity, idempotence, convergence and a no-lost-write oracle: 3 seeds x 3,000 runs, 0 failures, re-run in this pass [V]. It does not model rule R, materialization, implicit registers, candidates or redaction; those get property tests (13.1).

### 4.6 Materialization

A deterministic function, run after every merge or capture that changed anything:

1. **Rows.** A row is live if its provisional `_life` is `live`. History rows are materialized only when their entry is live.
2. **Fields.** Provisional values; `tags` = the sorted set of present `tag:*` registers; `config` = the `config.*` registers written as JCS. `updated_at`, for rows whose content changes, = ISO of the largest provisional app-dot `ms` or pseudo `lt` in the row; if that is 0, keep the stored text. Same format desktop writes today (`vault.ts:311`) [V]. Registers whose only values are redacted materialize as defaults.
3. **Containers.** A dangling target (dead or missing) materializes as root with `mat = 'r'`; the logical value stays in the register. In a cycle among folders, or among entries through `parent_entry_id`, the node whose `container` dot ranks highest goes to root, and a structural conflict is derived. The live tables never contain a cycle; desktop's recursive CTEs use `UNION ALL` and would never finish on one (`database.ts:188-221`) [V].
4. **`credential_id`** pointing at a dead or non-credential entry materializes as NULL with `mat` set.
5. **Write order,** one transaction with `PRAGMA defer_foreign_keys = ON`: upsert live folders, upsert live entries, upsert live history, delete non-materialized history, delete dead entries, delete dead folders. Foreign keys are on in both apps (`database.ts:69`; `VaultDatabase.swift:47-48`) [V]; the fallback rules ensure no live row references a dead one.
6. **Bookkeeping.** Update `sync_row.materialized` and `raw_hash`. Move a dead row's provisional values to `sync_grave`. Write `vault_meta.salt`, `verification` and `key_source = 'password'` for the current epoch.

### 4.7 Deletes, tombstones and "Delete permanently"

- **A delete is a dot on `_life = dead`.** Desktop's recursive `deleteFolder` (`vault.ts:359-366`) writes `dead` on the folder and every descendant with one dot. `deleteEntry` also moves the entry's children to its own container; those changes share the delete's dot.
- **No automatic garbage collection in format 1** (red team #2). A dead row keeps its registers, siblings, pseudo memory and grave. The time-based purge and the "straggler" rule are removed: both broke commutativity and could silently revert or lose edits. Tombstones cost about 0.6 KB per deleted row. Purging under causal stability (every known replica has published a version vector covering the delete) is reserved for `sync_format 2`.
- **Edit versus delete.** A concurrent edit re-asserts `live`, which gives a `_life` conflict. The provisional value is `live`, so nothing is hidden until the user chooses. This holds however long the other device was offline.
- **Recently deleted** lists rows whose provisional `_life` is `dead`, from their graves (last 30 days shown, [Show all]). Restore is an interactive write of `live` with the grave's values.
- **Delete permanently** (per item, or [Empty Recently deleted]) is a redaction, not a dot:
  - `sync_grave.row_json` becomes NULL and `redacted = 1`.
  - Every sibling value of that row becomes NULL with flag bit 1, and `sync_reg.vhash`/`sync_sibling.vhash` are zeroed.
  - Dots and pseudo memory stay, so coverage still works. Redaction wins in merge, so it reaches every device.
  - If a concurrent edit later revives the row, fields with only redacted values materialize as defaults and the item shows "Some fields of this item were permanently deleted".
- The password-change dialog offers "Also permanently delete items in Recently deleted" (recommended when the old password leaked).

### 4.8 Secrets and master-password changes (key epochs)

- **Epoch record:** `(epoch_id, parent, salt, verification)` plus wraps in `sync_key_wrap`. `epoch_id = hex(trunc16(HMAC-SHA256(K_epoch, "conduit-epoch-id-v1")))` is a key check value, so any device that holds a key can confirm which epoch it belongs to. The current epoch is the `_sync/key/epoch` register, so concurrent changes are detected like any other conflict.
- **Wrap validity (red team #34).** A wrap `(E, T, blob)` is valid if it authenticates under `K_E` with AAD `E ‖ 0x1f ‖ T` and the unwrapped key's check value equals `T`. Invalid wraps are ignored; they stay in the union set and do no harm. A buggy or tampered wrap can never displace a valid one.
- **Password change on a new build**, one W transaction, replacing `changePassword` (`vault.ts:1215-1258`):
  1. new salt, derive `K2`;
  2. re-encrypt every secret in content, siblings and graves;
  3. recompute the keyed `vhash` of secret registers (pids never change);
  4. add epoch `E2` (parent `E1`) and the wrap `(E2, E1, AES-GCM(K2, K1))`; write the `epoch` register with a new dot;
  5. write `vault_meta` salt, verification and `key_source`;
  6. redact `E1` (below); optionally erase Recently deleted (4.7).

  Then publish. This also fixes today's non-atomic salt write after `rekey` (`vault.ts:1254-1255`) [V] and `rekey` stamping `updated_at` on every secret entry (`vault.ts:1179`) [V]: the sync version creates no content dots.
- **Redaction of superseded epochs (red team #21, #27).** Once a state's current epoch reaches an ancestor through valid wraps, that ancestor's `verification` becomes NULL. Its `salt` also becomes NULL unless the state holds undecryptable siblings (they need salts for "Enter old password"). NULL wins in merge. Old passwords then cannot be tested offline against the file.
- **Unlock policy.** A typed or biometric password is accepted only if it derives the key of W's current epoch; or of S's current epoch when that epoch is newer and reaches W's through valid wraps, or when this device has no W yet; or the key matching S's `vault_meta` salt and verification when a legacy password change is detected. A password that matches an ancestor epoch is rejected. The app can only tell it is an old password while the shared file it reads still holds that epoch's verifier (a file from before the change, for example one the cloud drive brought back); then it says "Your master password was changed on MacBook on Sep 24. Enter the new password." and deletes a biometric entry holding that password. After redaction (below) nothing can check the old password any more, so it gets the plain "Invalid master password", like any wrong password, and a biometric entry holding it fails the same way. The old password never opens a newer vault state.
- **`alignEpoch(S, W)`** runs before every merge:

  | Relation | Action |
  |---|---|
  | Same current epoch | Proceed |
  | S's epoch is an ancestor of W's (S is older) | Unwrap S's key through W's wraps. Absorb S's legacy edits under S's own epoch, then re-encrypt S's secrets in memory up to W's epoch. No new dots. |
  | W's epoch is an ancestor of S's (S is newer) | Pause merge and publish; keep working locally. Banner: "Your master password was changed on MacBook. Enter the new password to keep syncing." On entry: derive K2 from S's salt, check the key check value, unwrap K1 and confirm it, re-encrypt W up to S's epoch, merge (with the 5.10 pre-merge snapshot). Pending edits survive. |
  | S's `vault_meta` salt/verification don't match S's recorded epoch | Legacy password change (below) |
  | Neither is an ancestor | Concurrent change (below) |

- **Legacy password change** (desktop 0.17 or older only; iOS has none, confirmed by grep of `IOS/ConduitiOS` for `changePassword|rekey`) [V]:
  - The device asks for the new password. It builds the epoch row with `epoch_id = KCV(K2)` (every device computes the same), `parent` = the recorded epoch, and a pseudo dot on the `epoch` register.
  - **If it also holds the old key** (it was unlocked, or the user enters the old password): add the wrap and absorb precisely.
  - **If not:** non-secret registers are absorbed precisely (their hashes are unkeyed). Each secret register gets a pseudo sibling from S's current plaintext under K2. W's own unpublished secret values cannot be read and become undecryptable siblings: "3 passwords saved on this device before the password change can't be read." [Enter previous password] [Discard]. Graves and siblings in S still under K1 are flagged undecryptable the same way. A device that later holds both keys adds the wrap and re-encrypts them. Nothing is lost silently.
- **Stale-key legacy secret.** iOS 1.0.5 never re-checks its key after a pull (critic B4) [V], so it can write a secret under an older key. Try the current key, then every key reachable through valid wraps; if one works, absorb the value re-encrypted under the current key. If none works, keep it as an undecryptable sibling (never provisional) with [Enter old password] [Discard]. "Enter old password" trial-decrypts that specific ciphertext with `PBKDF2(password, s)` for each retained salt `s`; no stored verifier is needed.
- **Concurrent changes** (A: E1 to E2a; B: E1 to E2b): the `epoch` register conflicts, and publishing pauses on any device that cannot decrypt both branches. The user enters the other password once and picks. The losing key is wrapped under the winner (`(E_win, E_lose, ...)`), everything is re-encrypted into the winner, and devices unlocked with the losing password must enter the winning one.
- **Local copies after a password change on this device.** Right after the change commits, the private copies kept beside W stop opening with the old password. W, `local.json` and S are never removed, and a copy that cannot be changed only logs (the password change stands).
  - `snapshots/`: each snapshot's `VACUUM INTO` copy of W is removed and `diff.json` is rewritten (temp file and rename) with every secret a ring key opens re-encrypted under the new epoch; `meta.epochId` becomes the new epoch. Undo reads only `diff.json`, so it keeps working for the full 30 days. The copy of W is removed rather than re-keyed: re-keying it would mean running the whole re-key transaction on a second vault database, and nothing reads it. A snapshot whose `diff.json` cannot be read is removed. Secrets no key opens stay as they are (undo skips them anyway).
  - `genesis.conduit` is removed. Re-encrypting it would change its bytes, and the G2 baseline absorb (4.4) only uses it while its SHA-256 equals `W.genesis_id`. Without it a later pre-sync S goes through G2 step 3 (candidate review), which never infers deletes.
  - `quarantine/` is emptied: torn copies cannot be re-keyed.
  - `incoming/` is emptied. S itself stays under the old password until the next publish, and the cycle before that publish stages it again, so `drop_staged_after_publish` is set in `local.json` and `incoming/` is emptied once more after the first publish (it survives a restart).
  - Not covered: copies outside the lineage's private folder that the user or other apps keep (exports, local and cloud backups, the cloud provider's version history). They keep the password they were made with.
- **Security note.** The new password reaches old keys through wraps. The old password never reaches the new key, and after redaction it cannot even be checked against the file. After a change on this device it no longer opens this device's private copies either (above).

### 4.9 Candidates

A candidate is any file merged on purpose rather than as the shared file: the iOS 1.0.5 sandbox, a private copy of S plus a leftover `-wal`, a copy of the vault in the folder, a file the user picks, or `W_g` from G3.

| Kind | When | How it merges |
|---|---|---|
| Replica candidate | Has sync tables, same lineage, same `genesis_id` | Absorb its legacy edits against its own sync tables (4.3), then merge like S. Precise: a stale copy contributes nothing (red team #19). |
| Synthetic candidate | No sync tables, a different `genesis_id`, or leftovers from G3 | Diff its content against the current state M and mint the differences as app dots of a fresh synthetic replica (below). |

**Synthetic candidate rules (red team #3):**
- A fresh `dev_syn` per import: first 48 bits of `SHA-256("cand" ‖ device_uuid ‖ random)`, recorded in `sync_dev`. One dot `(dev_syn, 0, 0)` for the whole import; `vv[dev_syn] = (0, 0)`. A fresh id per import means two devices importing the same file can never cover each other's minted values.
- Mint a sibling only for a register whose canonical value differs from M's provisional value, with `lt` = the candidate row's `updated_at`. For stale-by-nature candidates (1.0.5 sandbox, pre-sync files, G3 leftovers), only rows whose candidate `updated_at` is newer than M's row time count.
- A row only in the candidate: if M has it dead, mint `_life = live` plus its differing registers (a `_life` conflict that restores from the grave); if M has no such row, mint all non-default registers plus `live` ("Items only in this copy").
- Never mint deletes. Rows in M missing from the candidate are listed as "Items missing from this copy (N)" with [Delete them too].
- `ms = 0`, so M's values stay provisional, and every difference is a labeled conflict.

**When the user is asked first:** every synthetic candidate, and every replica candidate whose contribution includes legacy edits, shows a preview (changed fields, items only in the copy, items missing, deletions) with [Merge and review] and [Don't merge]. A replica candidate whose contribution is only uncovered app dots merges without asking: app dots can add siblings but cannot silently revert or delete anything.

**Labels:** "Changes found on this iPhone" (1.0.5 sandbox), the file name for copies, "Unsaved changes from the previous Conduit version" (leftover WAL), "A copy saved by an older Conduit app" (G2 without baseline).

### 4.10 Conflict derivation

`listConflicts()` walks `sync_reg` and `sync_sibling` and returns every register that meets 4.5's conflict test, grouped by row, plus structural conflicts (cycles) from the last materialization. There is no stored queue. Local-only items (notices, held legacy changes, candidate previews, snoozes) live in `local.json` and never decide data.

---

## 5. Sync loop and file handling

### 5.1 Working copy

- **Desktop:** every shared vault uses `{syncRoot}/m-<hw8>/<lineage>/w.conduit`, WAL mode with `busy_timeout` as today (`database.ts:67-68`) [V], or DELETE mode if the root is on a network path (3.2).
- **iOS 1.1:** `Application Support/Vaults/<lineage>/w.conduit`, included in device backup so unsynced edits survive a phone restore. `incoming/` and `snapshots/` are excluded from backup. This also fixes the sandbox name clash where an external `X.conduit` wipes an in-app one (`IOS/ConduitiOS/Features/Vault/VaultFilePicker.swift:50-87`) [V].
- `reloadFromDisk` (`vault.ts:286-298`) and `startVaultWatcher` (`DESK/electron/ipc/vault.ts:49-72`) [V] are retired for personal vaults.

### 5.2 Reading and classifying the shared file

**Read.** Desktop copies S's bytes into `incoming/` with `fs.readFileSync`; iOS uses the existing `stageFromSource` (`VaultFileCoordinator.swift:191-244`) [V], changed so it no longer copies or folds source `-wal`/`-shm`. S-wal and S-shm are never read.

**Classify (red team #6, #13, #26):**

| Class | Test | Action |
|---|---|---|
| Unreadable | Header magic `SQLite format 3\0`; size a multiple of the page size; header page count matches the size when set; `PRAGMA quick_check`; required tables present when `sync_format` is set | Retry at 5, 15 and 45 s. If still unreadable after 2 minutes **and** the bytes did not change during the wait, copy them to `quarantine/` and republish from W (5.3). A torn writer still has its edits in its own working copy. |
| Foreign: newer format | `sync_format > 1` | Stop publishing to this path. W stays usable. Banner: "This vault was updated by a newer version of Conduit. Update Conduit to keep syncing. Your changes are saved on this device." |
| Foreign: another vault | Has sync tables and a `lineage_id` that differs from W's, or is not a Conduit vault at all (no `vault_meta` salt and verification) | Stop publishing to this path. Scan the folder for this vault's lineage (5.9). Prompt: "The file at .../Vault.conduit is now a different vault." [Locate this vault's file...] [Open the other vault instead] [Keep working on this device]. Never overwrite it. |
| Pre-sync | No sync tables | G1 or G2 (4.4). A verification token that no known key opens is a legacy password change, never "another vault". |
| Synced | `sync_format = 1`, same lineage | Normal merge; G3 when `genesis_id` differs |

A file is only ever replaced because it is unreadable, never because it is unexpected.

### 5.3 Publishing

**Desktop:**
1. Write this device's presence register with a new dot (the publish marker, 6.11) and set `sync_state.file_id` to the binding's `file_id`, in W.
2. `VACUUM INTO` a temp file under `syncRoot`, then switch that temp file to WAL mode and close it (`electron/services/vault/wal-header.ts`), which leaves header bytes 18/19 = 2/2 and no side files. `VACUUM INTO` alone writes a rollback-journal file (18/19 = 1/1) [V, `PROBES/vacprobe.cjs`], and shipped iOS 1.0.5 cannot open that: it runs `PRAGMA journal_mode = WAL` inside a transaction (`VaultDatabase.open`), which SQLite refuses for a rollback-journal file [V]. Every copy other apps may open (publishes, forks, exports, backups) gets the WAL header.
3. CAS: re-read S and compare its SHA-256 with the one just merged. If it differs, go back to the loop.
4. Copy to `<dir>/.~<name>.<rand>.tmp`, `fsync`, set its mtime to `max(now, observed S mtime + 2 s)` with `fs.utimesSync`, `rename` over S, `fsync` the directory. The mtime bump makes iOS 1.0.5 (`sourceMod > lastKnown`, `VaultManager.swift:515`) and desktop 0.17 (`stat.mtimeMs > this.lastMtime`, `network-watcher.ts:114,129`) [V] see the new file even when this computer's clock is behind (red team #22).
5. On Windows `EPERM`/`EBUSY`, retry at 0.1, 0.5, 2 and 5 s, then fall back to an in-place write (readers validate) with the same mtime rule.
6. Remove leftover `.~*.tmp` files older than 1 hour at start-up.

**iOS 1.1:** `writeBackIfUnchanged(expectedSHA:data:)` reads the source bytes inside the existing coordinated in-place write, compares SHA-256, and writes only if unchanged (otherwise `.changed`). After writing it sets the modification date with the same `max(now, observed + 2 s)` rule. `removeCompanions(of: source)` in `writeBack` (`VaultFileCoordinator.swift:161-168`) [V] is removed.

### 5.4 Watching

- Desktop: `fs.watch` on the directory (catches rename-replace), a 3-second `stat` poll on `(size, mtimeMs, ino)` compared with `!=`, and a content hash every 60 s. This replaces `network-watcher.ts`'s `>` test for personal vaults [V].
- iOS: keep the 5-second poll, compare with `!=` plus a hash, and add an `NSFilePresenter` [A: works under a file-only scope].
- `isNetworkPath` (`DESK/electron/services/vault/network-lock.ts:55-92`) [V] gains `~/Library/CloudStorage/*`, Windows iCloud paths with backslashes, Box, Nextcloud and Synology (critic B6).

### 5.5 Legacy side files (`-wal`/`-shm` next to S)

**Why.** A visible S-wal or S-shm means some SQLite connection has, or had, S open in place. New builds never do that, so it is an older desktop. Two hazards: a rename over a live legacy connection can send its later writes to an orphaned file, and a non-empty WAL next to our new S would be replayed onto it by any later in-place opener, mixing pages silently (`PROBES/walprobe/probe.cjs`: rows reverted and vanished, `quick_check: ok`) [V]. An idle 0.17 has an empty WAL and an unchanged `-shm` (it checkpoints with TRUNCATE after each mutation, `vault.ts:159-164`) [V] and has no idle auto-lock (critic B16) [V], so it looks exactly like a crashed one (red team #12).

**Rule (desktop).** Each poll records `(exists, size, mtime)` for S-wal and S-shm.

| State | Condition | Publishing | Legacy deletes and stale reverts |
|---|---|---|---|
| none | no side files | allowed | applied |
| present | side files exist and the user has not confirmed this exact set of tuples | paused | held (4.3) |
| confirmed | the user confirmed; tuples unchanged since | allowed | applied |

- **Reading and merging S continue in every state.** Only publishing pauses, and held legacy changes wait for the user.
- **Status while paused:** "An older version of Conduit may have this vault open on another computer. Update or close it there to sync safely. Your changes are saved on this device." [Conduit is closed on my other computers]. A reminder shows once a day.
- **Upgrade wording.** If this computer's `settings.json` lists this vault (`last_vault_path` or `recent_vaults`) and the side files last changed before this build's first launch, the text reads: "Conduit found files left by the previous version on this computer. If Conduit isn't open on another computer, choose Continue." [Continue].
- **Confirming** moves S-wal and S-shm into `{lineage}/sidefiles-<ts>/` (kept 30 days), applies or reviews held changes, then publishes. If S-wal is non-empty, the button reads [Review unsaved changes first]: copy S plus S-wal into `incoming/`, open that private copy, and handle it as a candidate (4.9), or as the genesis source when no W exists yet. This is the only way a WAL is ever applied: on a private copy, by user choice, with a preview.
- Any change to the tuples after confirmation returns to "present".
- **Upgrade recovery.** 0.17 on this machine may have quit while unlocked with uncheckpointed `vault_meta` writes, including a password change's salt (`vault.ts:1254-1255`; checkpoints only in `notifyMutation`, `vault.ts:159-164`) [V]. If the entered password fails against S but works against the private S plus S-wal copy: "Conduit found changes the previous version didn't finish saving, including a password change." [Recover them] runs the candidate review (or genesis from that copy).
- **Server flag.** Signed-in desktops send `flags.side_files = "present"` in heartbeats. Any device that sees this flag for the lineage within 2 hours (iOS 1.1 included, which cannot see sibling files [A, critic C6]) also pauses publishing and holds legacy deletes and stale reverts. Signed-out iOS gets no such help; the risk is no worse than today.
  - **Report time.** A flag counts from the time it was reported: the row's `heartbeat_at` (`vault_sessions_for` returns it from `20260927234038`), since every heartbeat writes `flags` while `last_active_at` moves only while that device is in use. A server that omits `heartbeat_at` falls back to `last_active_at`. The 2-hour window uses the same time, so an idle device that keeps reporting the flag keeps it in force.
  - **Covered by a confirmation.** Confirming records the time the side files were moved (`local.json` `sideFilesConfirmedAtMs`). On that device a flag reported at or before that time (compared on the server's clock, using the offset from the last heartbeat's `server_now`) is covered and no longer pauses, so publishing resumes right after the click instead of waiting for the other devices' rows to refresh. A flag reported after the confirmation, also by an idle device, or side files that reappear next to S, pause again.
  - **Clearing.** When a heartbeat's session rows show the flag gone, a sync cycle runs at once, so a device held only by the flag publishes within seconds instead of at the next 60 s safety poll.
- **No rename while present.** Renaming the vault in the app is refused while side files are present (not yet confirmed) or the server flag is recent: the rename would move S away from its `-wal`/`-shm`, the new name would look clean, and the next publish would replace the file under the old desktop's live connection.
- **Optional mitigation:** a desktop 0.17.x patch that makes old desktops close idle cloud-folder vaults (11.4).

### 5.6 The sync loop

```
syncCycle(reason):   // single-flight. Triggers: local edit (2 s idle, max 10 s), shared-file change, unlock,
                     // focus/foreground, "Sync now", 60 s safety poll, Realtime/heartbeat hints
  highWaterCheck()                                    // 4.1
  capture(W, Local(tick, interactive=false))          // full pass (4.2 step 6)
  if killSwitch || displaced: return
  for attempt in 1..3:
    s = readShared()                                  // bytes, sha256, stat
    if missingDebounced(s) -> 5.9; return
    c = classify(s)                                   // 5.2
    if c == UNREADABLE -> tornRetry(s); return
    if c is FOREIGN -> foreign(c); return             // never publishes to this path
    if c == PRESYNC:  S1 = presyncAbsorb(s, W)        // 4.4 G1 or G2
    else:             S1 = absorb(s)                  // 4.3 against S's own tables, under S's own epoch
                      if S1.genesis_id != W.genesis_id: S1 = adoptGenesis(W, S1)   // 4.4 G3
    S1 = alignEpoch(S1, W); if paused -> status; return   // 4.8
    devCollisionCheck(S1, W)                          // 4.1
    gen0 = W.gen
    M = merge(W, S1)
    M = commitMerge(M, gen0)                          // below
    if massChange(M): snapshotWithDiff(W_before, M)   // 5.10
    local.last_merged_sha = s.sha
    if digest(M) == digest(S1) and not contentRepairNeeded: status "Up to date"; return
    if publishBlocked(): status(reason); return       // side files, epoch pause, displaced, kill switch, foreign
    P = vacuumInto(W)                                 // 5.3, with the publish marker
    if publishIfUnchanged(P, s.sha):
      local.last_published = {sha(P), marker}; report written_vv (6.11); verify covers(S, P) at +15 s, +60 s
      return
  backoff 5 s doubling to 10 min

commitMerge(M, gen0):   // red team #8: never overwrite a local edit committed during the merge
  for attempt in 1..3:
    begin immediate transaction on W
      if W.gen == gen0: write M into W; W.gen += 1; commit; return M
    rollback
    Wnow = loadState(W); M = merge(Wnow, M); gen0 = Wnow.gen   // M already contains S1; merge is idempotent
  inside one write transaction: Wnow = loadState(W); M = merge(Wnow, M); write M; commit; return M
```

- `W.gen` is an in-memory counter owned by the one process that holds W, bumped by every local capture transaction. Nothing about it is stored in the file.
- **`digest(state)`** = SHA-256 over a canonical sorted dump of vv, register identities and hashes, pmem, devices, epochs, wraps and graves. Compared only on one device.
- **Content repair:** set when a legacy change was dropped or held (4.3) or S lacked sync tables. It forces one publish so older apps see the state again. At most once per distinct S SHA-256.
- **Renderer refresh** reuses `vault:entries-refreshed` (`DESK/src/App.tsx:803-817`) [V]. A new `sync:state-changed` feeds `PersonalSyncIndicator`: Up to date, Syncing, Waiting for {device}, Paused ({reason}), File not found, Offline, N changes not yet synced.
- **Termination.** A device publishes only when S lacks something it has (or needs content repair, once per S). Merges are joins, so every device reaches the same fixed point and stops.
- **Lock, quit and displacement** run a final cycle (3 s cap; 15 s when displaced). If it cannot finish, `pending_publish` stays set and the next unlock publishes. VaultHub shows "N changes not yet synced" for that vault.

### 5.7 Lost updates when the cloud drive silently overwrites

- A publish is never the only copy: W keeps every dot.
- At 15 s and 60 s after publishing, and on every later read, test `covers(S, P)`: `S.vv >= P.vv` and every register identity in P is present in S or covered by S. If it fails, the cloud kept another version; merge again (our uncovered dots survive) and republish.
- More than 3 regressions in 10 minutes back off writes (5 s up to 5 min) with "OneDrive keeps restoring an older copy of this vault. Your changes are safe on this device."
- If the overwritten device is closed, its edits wait in its working copy. Signed-in devices see the gap through publish markers (6.11).

### 5.8 Other copies of the vault

**Scanner (desktop).** At unlock, on directory change and every 5 minutes, list every `*.conduit` in the shared file's folder. Open each as a private copy, read its lineage, and skip different lineages and files in `ignored_copies`. Classify each same-lineage copy (red team #4, #14):

| Class | Test | What happens |
|---|---|---|
| 1. In use elsewhere | Its presence registers or the server sessions show a device whose `file_hint` names this copy (a `file_id` or file name that is not ours) | The "different copies" prompt below |
| 2. Nothing new | Everything in it is covered and it has no legacy edits. The presence and owner-claim registers of devices that had the copy open (and the devs and version-vector entries only they carry) do not count: they are not changes a user could review | Listed in the Sync panel under "Other copies of this vault" with [Move to Trash]. No notice. |
| 3. Safe provider copy | Its contribution is only uncovered app dots, and its name matches a provider conflict pattern | Merged automatically. Toast: "Merged changes from a copy OneDrive made ('Vault-DESKTOP-ABC.conduit')." [Show file] [Move copy to Trash]. The copy stays in place; its SHA-256 goes into `ignored_copies`. |
| 4. Everything else | Legacy edits, pre-sync, another genesis, or a name that is not a provider pattern | Notice: "'Vault 2.conduit' is a copy of this vault with 17 changes that aren't in your vault, including 15 deletions." [Review...] [Ignore this copy]. Review is the candidate preview (4.9). |

- **Provider conflict patterns** (class 3 only): `<stem> (conflicted copy ...)`, `<stem> (<name>'s conflicted copy ...)`, `<stem>.sync-conflict-*`, and `<stem>-<HOST>` only when `<HOST>` equals a device name or hostname in the copy's own presence registers. `<stem> 2` and `<stem> (1)` are **not** provider patterns, because Finder "Keep Both", Files "Duplicate" and browser downloads use them too.
- **Nothing is moved or deleted without a user click.** [Move to Trash] uses `shell.trashItem`.
- **iOS 1.1** cannot see sibling files. It reviews `NSFileVersion.unresolvedConflictVersionsOfItem(at:)` with the same classes (3 merges automatically, 4 asks) and marks versions resolved only after the merge or the user's Ignore [A: works under a file-only scope]. If the user opens a copy through the picker and its lineage matches an open vault, iOS offers [Merge into "Vault"] (candidate review).

**Different copies across devices (red team #9).**
- Every presence register and session row carries `file_hint {file_id, location, file_name}`. `location` = provider kind (`icloud`, `onedrive`, `dropbox`, `gdrive`, `box`, `smb`, `local`, `other`) plus the parent folder name.
- Trigger: another device of this lineage reports a different `file_id` or provider kind; or the same `file_id` but its publish marker has stayed uncovered for 24 hours while both devices published.
- Prompt: "MacBook syncs 'Vault.conduit' in iCloud Drive. This PC syncs 'Vault.conduit' in OneDrive. These are separate copies and they aren't syncing with each other." [Merge them...] (pick the other file; replica candidate) [Keep separate] (make this one a separate vault, 5.9) [Remind me later].
- Stale-file waits only count devices with the same `file_id` (6.11).
- Signed-out devices on different copies cannot be detected; they behave as two separate files.

**A copy on the same device** (same lineage at another path, not class 3): "'Vault Copy.conduit' is a copy of 'Vault.conduit'." [Use as a separate vault] [It's the same vault, merge] [Ignore]. If the user keeps using the copy as its own shared file, its binding gets a new `file_id`.

### 5.9 Missing, renamed and moved files; making a separate vault

- **Working copies are keyed by lineage, not by path.**
- **Missing** means missing for 30 s of repeated `stat` calls plus a directory listing. If the original name comes back in that time, keep it (red team #20).
- **Rebind** automatically (toast with [Undo]) only when exactly one same-lineage file is in the folder and its name does not match a conflict pattern. A conflict-pattern name is never rebound automatically.
- **Otherwise:** "Vault file not found at .../Vault.conduit. It may have been moved or renamed." [Locate...] [Keep working on this device] [Save a new copy here]. Never recreate the file at the old path.
- **Renaming inside the app** (`DESK/electron/ipc/vault.ts:215-270`) renames only S and updates the binding; there are no side files to rename.
- **Making a separate vault always writes a new file (red team #26).** [Use as a separate vault] and [Keep separate] open a Save dialog and write a new file with a new `lineage_id`, a random `genesis_id` and a new `vault_id`, from the chosen copy's merged state. The original copy is left untouched and added to `ignored_copies` with [Move to Trash]. No shared file ever has its lineage rewritten.
- **Take-over dialog** shows the holder's device, file name and location. If the location differs it adds "MacBook has this vault open from iCloud Drive; you're opening it from OneDrive." and [Use as a separate vault...]. The old "This is a different vault" link is removed.
- **Biometric data** is keyed by lineage instead of by path hash (`DESK/electron/services/vault/biometric.ts:55-57`) [V]; the existing file moves on the first unlock after the upgrade.
- **iOS bookmarks** usually follow renames within one provider [A]; if not, the user picks the file again.

### 5.10 Restores, snapshots and undo

- **Backup restore** (`cloud_backup_restore`, `cloud_vault_restore`, `local_backup_restore`; `DESK/electron/ipc/cloud-sync.ts:82-224`, `DESK/electron/ipc/local-backup.ts:120-157`) offers:
  - **Roll this vault back**, after a preview that lists every change, including items created since the backup that would be deleted and newer values that would be replaced. Applied as interactive writes. Before a secret is replaced, its current value goes to `password_history` with `changed_by = 'rollback'`.
  - **Restore as a new vault**: a new file with a new lineage (5.9).

  A plain file overwrite is never used; the merge would undo it.
- **Pre-merge snapshots.** Before applying a merge that deletes 10 or more live rows or changes 25% or more of them (minimum 10), `VACUUM INTO` a copy in `snapshots/` and write `diff.json`: the rows this merge deleted (with values) and the fields it changed (before and after). Keep the last 5 for 30 days. After a password change on this device the copy is removed and `diff.json` is re-encrypted under the new epoch (4.8); undo only needs `diff.json`.
- **Password flows take the same snapshot.** Entering the new password (S newer, while running or at unlock), adopting a password change made by an older app, and resolving concurrent changes all merge S into W, so a mass delete can arrive together with a password change. Each flow takes the pre-merge snapshot and records the 'mass-change' notice before it commits, like a cycle does. The diff compares W already moved into the new epoch with the merged state, so re-encrypting every secret is never a mass change on its own, and the snapshot's `epochId` is the new epoch. If a local edit lands while the snapshot is written, the flow rebuilds its merge from W as it is then (as `commitMerge` does).
- **Targeted undo (red team #5).** Notice: "MacBook deleted 42 items." [Review] [Undo]. Undo shows a preview of only the rows this merge deleted and, optionally, the fields it changed. On confirm it re-creates exactly those rows (interactive `live` plus the snapshot's values) and, for changed fields, writes the old value only where the field still holds the merged value. Nothing else changes. Rows the user has since erased with "Delete permanently" (redacted grave, 4.7) are left out of the preview and never re-created.
- **Shared-file merges are never blocked,** because a real mass delete must propagate. Candidate merges ask first (4.9).
- **"Recently deleted"** restores from graves (4.7).
- **Backups** snapshot W with `VACUUM INTO` instead of reading `currentVaultPath`.
- **A legacy desktop restoring over S** looks like a legacy edit. A pre-sync backup goes through G2; a backup with older sync tables is covered and undone. Documented: "Restore with Conduit 0.18 or later."

### 5.11 Turning sync off and downgrades (red team #16)

- **Desktop decision:** there is no user-facing on/off switch. Turning the engine off would let a signed-out Free device skip the one-device rule (6.1). `personal_sync_enabled` in settings.json and the `sync_set_enabled` channel stay for support, with the rules below; the server kill switch (8.1) pauses sync for everyone.
- The Labs toggle (Phase 1) cannot be turned off while any lineage has `pending_publish` or held legacy changes. The dialog offers [Publish now] (running the side-file confirmation if needed) and [Export unsynced changes], which writes `<name> (unsynced changes).conduit` to `exports/` and reveals it. The export can be merged later as a candidate.
- A build with the engine off checks `syncRoot` at start. If any lineage has `pending_publish`: "12 changes to 'Vault' exist only on this device." [Turn sync back on] [Export them].
- A downgrade to 0.17 cannot be detected. Release notes tell users to wait for "Up to date" first.

### 5.12 Schema and version compatibility

| Client | Opens a sync-format file? | Behavior |
|---|---|---|
| iOS 1.0.5 | Yes, as long as the file has a WAL header (5.3 step 2): `schema_version` 10 is at most 10 (`VaultMigrations.swift:32,83-88`) [V]. Creates new vaults at v9 (`:27`) [V]. | Legacy writer, absorbed (4.3) |
| iOS 1.0.6 (10.1) | Yes | Legacy writer that keeps unknown config keys and stops folding side files |
| Desktop 0.17 or older | Yes, at any version (`database.ts:97-99`) [V]. `CREATE_SCHEMA` is IF NOT EXISTS (`schema.ts:10-61`) [V], so sync tables survive. | Legacy writer, absorbed. Its side files pause our publishing (5.5). |
| Desktop 0.18 with the engine off | Same as 0.17 | Same as 0.17, plus the pending warning (5.11) |
| Desktop 0.18+ and iOS 1.1+ | Yes | Full participant. Missing `sync_format` means pre-sync. `1` is supported. Above `1`: foreign, read-only for that path (5.2). |

- iOS 1.1 creates new vaults stamped 10, with sync tables and `password_history`; `latestSchemaVersion` stays 10.
- An older desktop still opens every file.

---

## 6. Free single-device enforcement

### 6.1 The rule

- **Scope:** per vault (lineage) and per account. At most `vault_max_open_devices` devices may have the vault open. Free = 1, Pro = -1, Team = -1 (-1 means unlimited). Signed-out and local-mode devices count as Free.
- **"Open":** desktop, unlocked. iOS, unlocked and in the foreground (iOS suspends background apps, so the slot is released on background and taken back on return, 6.10).
- **What releases the slot:** locking, closing the window (it already locks, `DESK/electron/main.ts:752-770`) [V], quitting, signing out, iOS going to the background, or the lease expiring.
- **Which vaults:** every vault takes the server lease, including vaults inside the app's own data folder (red team #25). Owner claims, working copies and the copy scanner apply to shared vaults (3.2: decided by `realpath`, so a `default.conduit` symlinked into Dropbox counts as shared).
- **Keys:** vault = `lineage_id`; device = `device_uuid`; running copy = `session_nonce`.

### 6.2 Timings

| Item | Value |
|---|---|
| Lease time limit | 90 s, server time |
| Heartbeat | Every 30 s while unlocked (desktop) or in the foreground (iOS) |
| `p_active` | Desktop: `powerMonitor.getSystemIdleTime() < 60` or the window was focused in the last 60 s. iOS: in the foreground. |
| `p_busy` | Desktop: `{sessions: open terminal/RDP/VNC/web/command sessions, jobs: running MCP or agent jobs}`. iOS: `{sessions: open SSH sessions}`. |
| Displacement signal | Realtime UPDATE on the device's own row (about 1-2 s); fallback: next heartbeat (at most 30 s) or iOS returning to the foreground |
| Early in-use check | Before the password prompt, 3 s timeout, skipped when offline |
| Final save when displaced | At most 15 s (merge + publish), then soft lock regardless |
| Offline retry of acquire | Every 60 s while unlocked |
| Reconnect finds another holder | Dialog; with no answer after 60 s this device soft-locks |
| Stale-file wait | Free: dialog with [Open now] from the start; auto-continues. Pro: banner. |
| Signed-out claim prompt | Only if the other device's presence shows activity within 15 min (values more than 5 min in the future are ignored) |
| Desktop sleep | `powerMonitor` `suspend`: stop the heartbeat. `resume`: heartbeat at once; a `lost/expired` answer triggers a normal acquire. |

### 6.3 Unlock sequence

**Desktop.** A new `openPersonalVault({path, secret, source, takeover})` in the main process replaces the body of all nine unlock paths: `vault_initialize`, `vault_unlock`, `biometric_unlock`, `vault_create`, `vault_rename`, `migrate_legacy_vault`, `cloud_vault_restore`, `cloud_backup_restore`, `local_backup_restore` (desktop-vault-lifecycle section 1) [V]. Today `unlock` opens the database before it checks the password (`vault.ts:218`, check at `:236-245`) [V].

1. **Resolve.** `realpath` the path; decide shared or private (3.2).
2. **Peek** (shared only). Copy S's bytes to `{syncRoot}/tmp/peek-<rand>.conduit` and open that private copy. Read `vault_meta.salt`, `verification`, `sync_state.lineage_id` (or the binding for a pre-sync file), `sync_format`, the epoch, the owner claim and presence registers. Nothing in the shared folder is written. If S is missing or unreadable, use W and show "offline file" mode.
3. **Early in-use check.** Signed in: `vault_session_peek(lineage, device_uuid)`; if `limit != -1` and another device holds the vault, show the take-over dialog (6.5) now, so the user never types a password only to be refused. Signed out: apply 6.7 to the peeked file.
4. **Verify the password** under 4.8's unlock policy. A typo has no side effects.
5. **Acquire** (signed in): `vault_session_acquire(..., session_nonce, file_id, location, takeover)`.
   - `granted`: keep `lease_id`; the lease is "confirmed".
   - `granted: false` (a race after the peek): show the dialog again.
   - Network error, 5xx or SQL error: continue with the lease "unconfirmed" (6.8). Never treat a server error as a denial.
6. **Open or create W.** New incarnation for this launch. G1, G2 or G3 as needed. iOS absorbs its 1.0.5 sandbox here (10.4).
7. **One sync cycle** with a 3 s budget. Write the presence register (`session_open = 1`) and, if the effective limit is 1 and the vault is shared, the owner claim.
8. **Start** the SyncEngine, heartbeat and Realtime subscription.

**Errors reach the renderer as structured JSON:** `{"code":"VAULT_OPEN_ELSEWHERE","holders":[...],"limit":1,"fileName":"Vault.conduit"}`, plus `VAULT_PASSWORD_CHANGED_ELSEWHERE`, `VAULT_FILE_UNREADABLE` and `VAULT_FOREIGN_FILE`. `vaultStore.unlockVault` must stop turning every error into "Invalid master password" (`DESK/src/stores/vaultStore.ts:276-281`) [V]; parse the JSON as `TeamVaultUnlock.tsx:28-42` does.

**iOS.** The same sequence runs in a new `VaultAccessCoordinator`, called from `VaultManager.open`, `openWithKey`, `createVault` (`VaultManager.swift:128-222`), `VaultTab.openVaultFromSource` and `restoreDeviceVault` (`VaultTab.swift:197-220, 268-288`) and biometric re-auth (`ConduitApp.swift:24-39`).

### 6.4 Release points

- **Desktop:** `lockVaultFromMain` (`DESK/electron/ipc/vault.ts:133-140`) [V]: final sync (3 s cap), presence `session_open = 0` with a publish, `vault_session_release(lease_id, written_vv, pending)`. `before-quit` (`main.ts:1000-1034`) neither locks nor releases today [V]: add the same bounded flush and release. `powerMonitor` `suspend`: stop the heartbeat; the lease expires after 90 s.
- **iOS:** `VaultManager.lock()` and `close()` (`VaultManager.swift:230-266`), `VaultTab.closeAllVaults`, `SwitchVaultModifier.performSwitch`, the Settings Lock/Close buttons, `EntryListView.closeOrLockVault`, `AuthService.signOut` (ios-app section 4a), and the scene going to the background (6.10).

### 6.5 Take-over

```
B: vault_session_peek / acquire(takeover=false)
     -> {granted:false, holders:[{device_name:"Chris's MacBook", platform, file_name, location,
                                  last_active_at, busy:{sessions:3, jobs:1}}]}
B UI: "This vault is open on Chris's MacBook (active 20 seconds ago).
       MacBook has 3 open connections and an AI task running. They keep running; only the vault locks.
       On the Free plan a vault can be open on one device at a time."
       [Use here instead]  [Cancel]  [Upgrade to Pro]
       (if the location differs: "MacBook has this vault open from iCloud Drive; you're opening it
        from OneDrive." + [Use as a separate vault...])
B: acquire(takeover=true) -> one server transaction:
       A.status = 'displaced', displaced_by = B, reason = 'takeover'; B active with a new lease_id
       returns sessions[] with each device's publish marker, pending flag, file id
B: usable at once. "Getting the latest changes from MacBook..." until S covers the expected markers (6.11).
A: learns 'displaced' (Realtime, about 1-2 s, or its next heartbeat) -> 6.6
```

A take-over never loses data: the displaced device saves and publishes before it locks, and every edit also lives in its working copy.

### 6.6 What the displaced device does (soft lock)

1. Overlay: "Opened on iPhone. Saving your last changes...". Vault reads and writes are blocked from this moment.
2. Final sync cycle (merge + publish, 15 s cap).
3. `vault_session_release(lease_id, written_vv, pending = publish failed?)`.
4. **Soft lock** (red team #29): stop the SyncEngine and backups, clear the vault key and the master-password buffer, and block vault access. IPC and MCP vault calls get the locked-vault error with reason `open_elsewhere`. Open terminals, RDP, VNC, web sessions and running commands keep running; opening a new connection that needs vault data fails until the vault is reopened. A manual lock still closes everything, as today (`lockVaultFromMain`, `state.ts:229-237`) [V].
5. Modal:
   - Take-over: "This vault is now open on iPhone. Your changes from this device were saved. Your 3 open connections are still running." [Use here instead] [OK]
   - Plan limit: "Your plan now allows this vault on one device at a time. It stays open on MacBook." [Use here instead] [Upgrade]
   - Owner claim (6.7): "This vault was opened on iPad. On the Free plan a vault can be open on one device at a time." [Use here instead] [OK]
   - Superseded (another running copy with this device's identity, for example a cloned computer): "Conduit was opened with this computer's identity somewhere else." [Use here instead] [OK]

If the publish failed, the changes stay in this device's working copy and publish at its next unlock. The server's `pending_changes = true` lets the active device show "MacBook has changes that haven't synced yet. They'll sync the next time the vault is opened there."

### 6.7 In-file owner claims (signed-out, local mode, unconfirmed leases, other accounts)

- **Where:** the `_sync/owner/owner` register, value `{"a": account_hint or null, "d": device_uuid}`, and each device's presence register.
- **Who writes a claim:** any device whose effective limit (6.8) is 1, for a shared vault, at unlock and at take-over.
- **Who honors claims:** any device whose effective limit is 1. The provisional owner (highest-ranked claim dot) is authoritative, with one exception: a claim is ignored when **both** this device and the claimant hold a live server lease for this vault (the claimant's `device_uuid` is active in this device's latest sessions list and this device is confirmed). Then the server is already deciding. This closes the "block the Supabase host" bypass: a device without a confirmed lease is always subject to claims, whatever its account (red team #24).
- **Prompt at unlock:** if the provisional owner is another device whose presence shows `session_open` and activity within 15 minutes, show the take-over dialog; otherwise claim silently. The stale device is displaced on its next merge.
- **Displacement on every merge:** a device that honors claims is displaced (6.6) when the provisional owner is another device.
- **Latency:** detection depends on cloud-drive delivery (seconds to minutes). Edits made in that window are merged, so nothing is lost.
- Pro and Team devices with a known unlimited limit never write or honor claims.

### 6.8 Effective limit and offline behavior

| Situation | Effective limit |
|---|---|
| Signed in, lease confirmed (last acquire or heartbeat OK within 90 s) | The server's limit |
| Signed in, unconfirmed (pending, offline, host blocked, server or SQL error) | The last server limit for this vault from `local.json`, else `cached_tier_capabilities`, but only if it is at most 7 days old **and** not dated in the future; otherwise 1 |
| Signed out, local mode | 1 |

- Cache sanity: `loadCachedTierCapabilities` (`DESK/electron/services/auth/supabase.ts:705-721`) [V] computes `Date.now() - timestamp`, so a future timestamp never expires. Reject timestamps more than 5 minutes in the future, in both the cache and `local.json`.
- **Packaged builds ignore `CONDUIT_ENV`.** `getEnvConfig` honors it with no `isPackaged` check (`DESK/electron/services/env-config.ts:55-66`) [V], which lets a packaged app talk to a user-run local Supabase that returns `limit: -1`.
- **Offline at unlock:** open anyway; the lease is unconfirmed, retried every 60 s; badge "Offline: device check paused". Claims apply per 6.7.
- **Reachable again:** if another device holds a live lease: "This vault is also open on MacBook." [Use here instead] [Lock here]; with no answer after 60 s this device soft-locks (its data is already safe in W). Otherwise take the slot silently.
- **Cold start with no profile** (critic B1) [V]: enforcement never needs the profile; the server decides, and the table above covers the rest.
- **Deviation from the red team:** a cached Pro value (at most 7 days, not future-dated) may raise the limit, so Pro users behind firewalls that block Supabase keep multi-device use for a week.

### 6.9 Plan changes

- **Downgrade.** Every heartbeat recomputes the limit. If more devices are active than allowed, the server keeps busy devices first, then the most recently active (`busy` desc, `last_active_at` desc, `device_id`), and marks the rest `displaced` with reason `plan_limit`. They soft-lock (6.6). Conflicts, working copies and review stay available on Free.
- **Upgrade.** The next heartbeat returns -1; prompts and claims stop; displaced devices can reopen. No data changes.

### 6.10 iOS specifics

- **Heartbeat** only in the foreground, every 30 s, on its own timer.
- **Background:** `beginBackgroundTask`, final sync (flush pending edits), then `vault_session_release`. The presence register is not changed on background, so there is no upload on every app switch; it changes only at unlock, lock and publish. A stale `session_open = 1` never prompts anyone, because prompts also need activity within 15 minutes (6.7).
- **Foreground:** `vault_session_acquire(takeover=false)` in the background while the UI stays usable. Denied: soft-lock, then "Opened on MacBook while Conduit was in the background." [Use here instead] [OK]. Offline: unconfirmed (6.8).
- **Device id:** the Keychain item `conduit.sync.device` (`ThisDeviceOnly`), not restored onto a new phone. The global UserDefaults `conduit-device-id` (`IdentityKeyService.swift:73-80`) [V] stays for team keys only.
- **iOS 1.0.5 cannot be gated.** It never calls the server and never writes claims. Accepted.

### 6.11 Stale file when moving between devices

**Case:** device B opens before the cloud drive has delivered device A's last publish.

- **Publish marker (red team #32).** Every publish writes the publisher's presence register with a new dot from its current dev (5.3). After a publish, and at release, the device reports `written_vv = {"<current dev>": [ms, c]}`, that single marker. Because a marker dot only exists in states derived from the publisher's W at that moment, `S.vv[dev] >= marker` proves S contains everything that device had published. One entry per session keeps the payload tiny whatever the number of incarnations.
- **Expected markers.** Acquire and heartbeat return the sessions of this user and vault from the last 30 days. B collects the markers of sessions that have the same `file_id`, are not abandoned, and are not in this device's `abandoned_waits`.
- **Test.** S is stale if any expected marker is not covered by `S.vv`.
  - **Free:** a dialog "Getting the latest version from MacBook (saved 2 minutes ago)...", polling every 2 s and continuing on its own when covered. On iOS it also calls `ICloudDownload.ensureDownloaded`. [Open now] is available from the start (red team #30). After 2 minutes it adds [Stop waiting for MacBook].
  - **Pro:** a non-blocking banner with the same actions.
- **[Stop waiting for MacBook]** calls `vault_session_abandon`, which excludes that session until it reports a new marker. After one timed-out wait, this device also drops that marker from later waits (`abandoned_waits`) until it changes.
- **"Open now" is always safe.** When A's file arrives it merges. If the drive dropped A's file, A republishes from W the next time it runs (5.7).
- **Signed out:** no server help. If the peeked file shows the previous device with `session_open = 1`: "MacBook may still have this vault open, or its last changes haven't arrived yet." [Wait] [Use here].

### 6.12 What changed for Free versus the synthesis

- Leases for every vault; claims honored whenever the lease is not confirmed.
- Lease id per acquire; a heartbeat never revives a released or expired session (9.5).
- Session nonce; a second running copy with the same device id supersedes the first.
- Soft lock and busy reporting.
- Publish markers, file-id scoping, abandon and "Open now" from the start.

### 6.13 Known limits (accepted)

- Enforcement is client-side. A modified client, or edited local state, can skip it.
- Signed-out and unconfirmed enforcement is best effort, with cloud latency.
- Older apps (iOS 1.0.5, desktop 0.17 or older) are not enforced.
- Two Conduit accounts on one vault are separate on the server; the in-file claim still displaces between them, best effort.
- Two devices on different copies while signed out cannot be detected.

---

## 7. Conflict queue and resolution UX

### 7.1 Creation and storage

- **A conflict exists** whenever a prompt or group A register holds more than one distinct value, an undecryptable sibling, or both `live` and `dead` in `_life`. It is created by the first merge or capture that sees both sides. Structural conflicts (cycles) are recomputed at every materialization.
- **Storage:** inside the file (`sync_reg` plus `sync_sibling`). There is no queue table; `listConflicts()` is derived, so it cannot drift, and every device sees the same queue after its next sync.
- **Legacy apps** see only the provisional value.
- **Local items** (notices, held legacy changes, candidate previews, snoozes) are stored per device in `local.json`.

### 7.2 What the user sees

**Desktop:**
- A sidebar badge "3 to review" on the new `PersonalSyncIndicator`.
- After unlock with conflicts: a non-blocking banner "3 changes from your other devices need review" [Review]. Status messages use the toast system (repo convention, `.claude/commands/notification.md`).
- Items with conflicts get an amber dot in the tree.
- Entry detail and editor show each conflicted field with its versions inline. Saving from the editor resolves that field and says so.
- MCP `entry_info` and `credential_read` return the provisional value plus `"has_conflict": true` (`DESK/electron/ipc-server/server.ts`).

**iOS:**
- A banner in `EntryListView`'s `syncWarning` slot (`IOS/ConduitiOS/Features/Vault/EntryListView.swift:65-97`) opens `ConflictReviewView`. Inline markers in `EntryDetailView`.

**The Review panel** groups by item. Per field: the label; every version with device and time ("Chris's iPhone, 2 h ago"; pseudo versions show "Older Conduit app, Sep 24"; candidate versions show the candidate's label); an "in use now" marker on the provisional value; secrets masked with a reveal button (vault unlocked); a side-by-side diff for notes and documents.

### 7.3 Actions

| Kind | Choices | Written as |
|---|---|---|
| Field | [Use this] per version; [Enter a different value...]; [Keep both] for notes and documents (creates "Doc (from iPhone)"); [Decide later] | Interactive app dot with the chosen value, replacing all siblings; force-stamped even if equal to the provisional value |
| Appearance group (icon, color, favorite, tags) | "Keep newest" preselected; [Apply] or per field | Same |
| Edit versus delete | "Deleted on MacBook (Sep 24, 10:02); edited on iPhone (10:05)." [Keep item] [Delete item] | `_life` live or dead, replacing all |
| Folder delete versus edits inside | "Folder 'Servers' was deleted on MacBook; iPhone changed 2 items in it." [Keep folder with changed items] [Delete folder and items] [Restore everything in folder] | Restore writes `live` on every row whose `_life` winner is that delete dot |
| Cycle | "Folders 'X' and 'Y' were moved into each other on different devices." [Put X in Y] [Put Y in X] [Both at top level] | `container` writes |
| Stale revert | "An older Conduit app on iPhone changed 'Host' back to an earlier value." [Keep 10.0.0.9] [Use 10.0.0.5] | Field write |
| Undecryptable value | "A password saved on iPhone used your old master password." [Enter old password] [Discard] | Re-encrypt, or drop the sibling |
| Held legacy changes | "While an older Conduit had this vault open, it deleted 2 items and changed 1 back." [Apply these changes] [Keep my versions] | Absorb as legacy, or interactive re-assertion |
| Dropped setting (notice) | "iPhone's older Conduit app doesn't support some settings of 'Prod RDP'. They were kept." [Remove them everywhere] [OK] | Optional interactive removal |
| Password epoch | Modal flow (4.8) | `epoch` register |
| Duplicate folders (suggestion) | "Two folders named 'Servers' were created on different devices." [Merge folders] [Keep both] | Moves plus a delete; a dismissal goes to `_sync/dismiss/<hash>` |
| Candidate | Per field as above; bulk [Keep the vault's values for all] or [Keep the copy's values for all]; "Items only in this copy" [Keep] [Discard]; "Items missing from this copy" [Delete them too] [Keep] | Same |
| Invariant guard (rare) | "Two versions of 'Host' were kept after a repair." | Field write |

- **Bulk:** [Keep newest for all] and [Keep newest for all older-app changes] (by rank, which includes `lt`).
- **Secret resolution:** the losing `password` plaintexts are written to `password_history` with `changed_by = 'conflict-resolution'`, so a password still in use somewhere is never lost. For `private_key` and `totp_secret` the dialog warns and offers [Keep both].

### 7.4 Provisional value, propagation and snooze

- **Before resolution** the highest-rank value is used everywhere (connections, MCP, older apps). For `_life`, the row stays live.
- **Propagation:** a resolution is an ordinary write whose dot covers every sibling; other devices drop the siblings after one sync. An open review panel refreshes and marks the item "Resolved on iPhone".
- **Two devices resolving differently** at the same time create a new conflict, which is correct. Resolving the same way creates none.
- **Snooze** is per device, keyed by a hash of the register key and its sorted sibling ids; the item returns at the next unlock.
- **Conflicts never expire and are never resolved automatically.** After 30 days the banner reads "Kept the newest version so far".

---

## 8. Plan gating

### 8.1 Tier feature keys (`tiers.features`)

| Key | Free | Pro | Team | Purpose |
|---|---|---|---|---|
| `vault_max_open_devices` | 1 (from Phase 2; -1 before) | -1 | -1 | New. Concurrent open devices per personal vault. |
| `cloud_sync_enabled` | false | true | true | Existing name kept for old clients; means whole-file cloud backup. Missing in both dumps (critic A4), so it is set explicitly. |
| `personal_sync` | "on" | "on" | "on" | Kill switch. "paused" stops merging and publishing; working copies keep every edit. |
| `mcp_daily_quota` | -1 | -1 | -1 | Quota removal (8.3) |

Team members get -1 server-side (`is_team_member`). The backend's hard-coded team feature object (`BE/src/lib/auth/verify.ts:77-100`) and `TierFeatures` (`BE/src/lib/types.ts:56-72`) add `vault_max_open_devices: -1` for consistency (critic B19). No backend route enforces it.

### 8.2 Where checks run

| Check | Runs in | Authority |
|---|---|---|
| May this device open the vault (limit, take-over) | Supabase `vault_session_acquire` | **Authoritative** when confirmed. Reads `user_profiles.tier_id` joined to `tiers`, plus `is_team_member`. |
| Downgrade displacement | `vault_session_heartbeat` plus Realtime | Authoritative |
| Acting on the result | Desktop `electron/services/vault-session/*` inside `openPersonalVault`; iOS `VaultAccessCoordinator` | Enforces the server's decision. Never uses the main process's profile, which can go stale (critic B2). |
| Owner claims | SyncEngine after each merge (6.7) | Best effort |
| Effective limit when unconfirmed | `effective-limit.ts` (6.8) | Best effort, can lower but only raise from a sane, recent server value |
| Cloud backup enable and resume | `DESK/electron/ipc/cloud-sync.ts:37-41` [V], plus new checks in `wireBackupServices` (`DESK/electron/ipc/vault.ts:102-111`) and both restore handlers | Profile features; fixes a downgraded vault that keeps uploading |
| Wording and upsell | `ai_get_tier_capabilities` (`DESK/electron/ipc/ai.ts`, writes `cached_tier_capabilities`) adds `vault_max_open_devices`; `tierStore`; iOS `ProfileService` and `TierGating` (`IOS/ConduitiOS/Core/Networking/TierGating.swift:12-49`) | Display only |

Merge engine, conflict review, legacy absorption and presence are not gated.

### 8.3 MCP quota

Set `mcp_daily_quota = -1` for every tier (this also uncaps old clients, which fall back to 50 only when the key is missing) and delete the quota code. That work is already underway on this branch: `git status` shows `mcp/src/daily-quota.ts`, `electron/services/mcp-quota.ts` and `src/components/ai/MCPQuotaCounter.tsx` deleted [V].

---

## 9. Supabase migrations

Files go in `DESK/supabase/migrations/`. Apply to the local stack first, then `supabase db push --project-ref khuyzxadaszwxirwykms`. They follow the advisor pattern: RLS on, `(select auth.uid())`, EXECUTE revoked from `anon` (`20260527000000_advisor_cleanup.sql`) [V]. `vault_locks` is not reused and not touched.

### 9.1 Files and order

| File | Phase | Content |
|---|---|---|
| `20260926150741_guard_user_profile_columns.sql` | 0 | Security prerequisite (9.2). Check live grants first with `information_schema.column_privileges` [A]. |
| `20260926150803_tier_vault_devices.sql` | 0 | Tier keys, all plans unlimited (9.3) |
| `20260926150829_personal_vault_sessions.sql` | 1 | Table, RLS, helpers, Realtime, purge job (9.4) |
| `20260926150905_personal_vault_session_rpcs.sql` | 1 | Peek, acquire, heartbeat, release, abandon (9.5) |
| `20260927234038_vault_sessions_heartbeat_at.sql` | 1 | `vault_sessions_for` also returns `heartbeat_at`, the side-file flag's report time (5.5) |
| `<date>_free_single_device.sql` | 2 | Free limit 1 (9.6), created when desktop GA ships |

### 9.2 `20260926150741_guard_user_profile_columns.sql`

**Why.** Every server gate assumes users cannot raise their own tier, and the `user_profiles` UPDATE policy has no column limit (`20260527000000_advisor_cleanup.sql:68-72`) [V; critic B22].

**Why a trigger, not a column revoke:** desktop updates `primary_team_id` as the user (`DESK/electron/services/team/team-service.ts:274`) [V], and the website checkout writes `stripe_customer_id` with the user-context client (`WEB/app/api/stripe/checkout/route.ts:13,76-78`) [V]. `tier_id` writers use the service client (`WEB/app/api/team/invite/accept/route.ts:110-114`, `add-self/route.ts:15,47,68`, `members/remove/route.ts:21,81`, the Stripe webhook) [V]. `sync_is_team_member` is `SECURITY DEFINER` (old `002_teams.sql:62-69`) [V; A: live definition matches], so it runs as its owner.

```sql
create or replace function public.guard_user_profile_columns() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('authenticated', 'anon') and (
       new.tier_id is distinct from old.tier_id
    or new.is_team_member is distinct from old.is_team_member
    or new.subscription_status is distinct from old.subscription_status
    or new.subscription_period_end is distinct from old.subscription_period_end
    or new.cancel_at_period_end is distinct from old.cancel_at_period_end
    or new.trial_ends_at is distinct from old.trial_ends_at
    or new.has_used_trial is distinct from old.has_used_trial
    or new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or (new.stripe_customer_id is distinct from old.stripe_customer_id and old.stripe_customer_id is not null)
    or new.abuse_score is distinct from old.abuse_score
    or new.is_suspended is distinct from old.is_suspended
    or new.suspended_reason is distinct from old.suspended_reason
    or new.registration_ip is distinct from old.registration_ip
    or new.registration_fingerprint is distinct from old.registration_fingerprint) then
    raise exception 'protected column' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_user_profile_columns on public.user_profiles;
create trigger trg_guard_user_profile_columns before update on public.user_profiles
  for each row execute function public.guard_user_profile_columns();
```

Follow-up: move the checkout's `stripe_customer_id` write to the service client, then remove the NULL-to-value exception.

### 9.3 `20260926150803_tier_vault_devices.sql`

```sql
-- Phase 0/1: presence only (every plan unlimited), quota removal, backup key made explicit.
update public.tiers set features = features || jsonb_build_object(
    'vault_max_open_devices', -1,
    'mcp_daily_quota', -1,
    'cloud_sync_enabled', name <> 'free',
    'personal_sync', 'on'),
  updated_at = now()
where name in ('free', 'pro', 'team');
```

It uses `||`, so it is safe against drift in the live `features` values (critic C1, C7).

### 9.4 `20260926150829_personal_vault_sessions.sql`

```sql
create table if not exists public.personal_vault_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  vault_key uuid not null,                        -- sync_state.lineage_id
  device_id uuid not null,                        -- device_uuid (per install)
  lease_id uuid not null,                         -- new on every acquire; heartbeat and release must match
  session_nonce uuid not null,                    -- per app launch
  device_name text not null check (char_length(device_name) between 1 and 120),
  platform text not null check (platform in ('macos','windows','linux','ios','ipados')),
  app_version text check (char_length(app_version) <= 40),
  file_name text check (char_length(file_name) <= 255),
  file_id uuid,
  location text check (char_length(location) <= 120),
  status text not null default 'active' check (status in ('active','released','expired','displaced')),
  acquired_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_active_at timestamptz not null default now(),
  busy jsonb not null default '{}'::jsonb
    check (jsonb_typeof(busy) = 'object' and pg_column_size(busy) <= 256),
  flags jsonb not null default '{}'::jsonb
    check (jsonb_typeof(flags) = 'object' and pg_column_size(flags) <= 256),
  displaced_by_device uuid,
  displaced_reason text check (displaced_reason in ('takeover','plan_limit')),
  displaced_at timestamptz,
  written_vv jsonb not null default '{}'::jsonb   -- one publish marker: {"<dev>": [ms, c]}
    check (jsonb_typeof(written_vv) = 'object' and pg_column_size(written_vv) <= 1024),
  written_at timestamptz,
  pending_changes boolean not null default false,
  abandoned_at timestamptz,
  primary key (user_id, vault_key, device_id)
);
create index if not exists personal_vault_sessions_active_idx
  on public.personal_vault_sessions (user_id, vault_key) where status = 'active';

alter table public.personal_vault_sessions enable row level security;
drop policy if exists "vault sessions: read own" on public.personal_vault_sessions;
create policy "vault sessions: read own" on public.personal_vault_sessions
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete, truncate on public.personal_vault_sessions from anon, authenticated;
grant select on public.personal_vault_sessions to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                 and schemaname = 'public' and tablename = 'personal_vault_sessions') then
    alter publication supabase_realtime add table public.personal_vault_sessions;
  end if;
end $$;

create or replace function public.vault_device_limit(p_uid uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p.is_team_member then -1
    else coalesce((t.features->>'vault_max_open_devices')::int,
                  case when t.name in ('pro','team') then -1 else 1 end) end
  from public.user_profiles p left join public.tiers t on t.id = p.tier_id
  where p.id = p_uid
$$;

create or replace function public.vault_session_is_busy(p_busy jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(case when jsonb_typeof(p_busy->'sessions') = 'number'
                       then (p_busy->>'sessions')::numeric > 0 end, false)
      or coalesce(case when jsonb_typeof(p_busy->'jobs') = 'number'
                       then (p_busy->>'jobs')::numeric > 0 end, false)
$$;

create or replace function public.vault_session_holders(p_uid uuid, p_vault_key uuid, p_device_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'device_id', device_id, 'device_name', device_name, 'platform', platform,
      'file_name', file_name, 'file_id', file_id, 'location', location,
      'last_active_at', last_active_at, 'busy', busy)
      order by last_active_at desc), '[]'::jsonb)
  from public.personal_vault_sessions
  where user_id = p_uid and vault_key = p_vault_key and status = 'active'
    and expires_at >= now() and device_id <> p_device_id
$$;

create or replace function public.vault_sessions_for(p_uid uuid, p_vault_key uuid, p_device_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'device_id', s.device_id, 'device_name', s.device_name, 'platform', s.platform,
      'file_name', s.file_name, 'file_id', s.file_id, 'location', s.location,
      'status', case when s.status = 'active' and s.expires_at < now() then 'expired' else s.status end,
      'last_active_at', s.last_active_at, 'heartbeat_at', s.heartbeat_at, 'busy', s.busy, 'flags', s.flags,
      'written_vv', s.written_vv, 'written_at', s.written_at,
      'pending_changes', s.pending_changes, 'abandoned', s.abandoned_at is not null)
      order by s.last_active_at desc), '[]'::jsonb)
  from public.personal_vault_sessions s
  where s.user_id = p_uid and s.vault_key = p_vault_key and s.device_id <> p_device_id
    and s.heartbeat_at > now() - interval '30 days'
$$;

revoke execute on function public.vault_device_limit(uuid) from public, anon, authenticated;
revoke execute on function public.vault_session_is_busy(jsonb) from public, anon, authenticated;
revoke execute on function public.vault_session_holders(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.vault_sessions_for(uuid, uuid, uuid) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then        -- [A] enabled in prod
    perform cron.schedule('purge-personal-vault-sessions', '17 3 * * *',
      -- By age alone: a lease that lapsed without a release stays 'active' (its 90 s TTL is long gone).
      $cron$delete from public.personal_vault_sessions
             where heartbeat_at < now() - interval '30 days'$cron$);
  end if;
end $$;
```

### 9.5 `20260926150905_personal_vault_session_rpcs.sql`

```sql
-- Read-only check before the password prompt.
create or replace function public.vault_session_peek(p_vault_key uuid, p_device_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'limit', coalesce(public.vault_device_limit(auth.uid()), 1),
    'holders', public.vault_session_holders(auth.uid(), p_vault_key, p_device_id))
  where auth.uid() is not null
$$;

create or replace function public.vault_session_acquire(
  p_vault_key uuid, p_device_id uuid, p_session_nonce uuid,
  p_device_name text, p_platform text, p_app_version text,
  p_file_name text, p_file_id uuid, p_location text, p_takeover boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_limit int;
  v_live int;
  v_lease uuid := gen_random_uuid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_vault_key is null or p_device_id is null or p_session_nonce is null then
    raise exception 'missing id' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_vault_key::text, 0));
  if (select count(*) from public.personal_vault_sessions
       where user_id = v_uid and heartbeat_at > now() - interval '1 day') > 200 then
    return jsonb_build_object('granted', false, 'error', 'too_many_sessions');
  end if;
  v_limit := coalesce(public.vault_device_limit(v_uid), 1);

  update public.personal_vault_sessions set status = 'expired'
   where user_id = v_uid and vault_key = p_vault_key and status = 'active' and expires_at < now();

  if v_limit <> -1 then
    select count(*) into v_live from public.personal_vault_sessions
     where user_id = v_uid and vault_key = p_vault_key and status = 'active' and device_id <> p_device_id;
    if v_live >= v_limit then
      if not p_takeover then
        return jsonb_build_object('granted', false, 'limit', v_limit,
          'holders', public.vault_session_holders(v_uid, p_vault_key, p_device_id),
          'sessions', public.vault_sessions_for(v_uid, p_vault_key, p_device_id), 'server_now', now());
      end if;
      update public.personal_vault_sessions
         set status = 'displaced', displaced_by_device = p_device_id,
             displaced_reason = 'takeover', displaced_at = now()
       where user_id = v_uid and vault_key = p_vault_key and device_id in (
         select device_id from public.personal_vault_sessions
          where user_id = v_uid and vault_key = p_vault_key and status = 'active'
            and device_id <> p_device_id
          order by public.vault_session_is_busy(busy) asc, last_active_at asc, device_id
          limit v_live - v_limit + 1);
    end if;
  end if;

  -- Same device_id with another live nonce (a second running copy) is superseded here:
  -- its lease_id no longer matches, so its next heartbeat returns lost/superseded.
  insert into public.personal_vault_sessions as s (
      user_id, vault_key, device_id, lease_id, session_nonce, device_name, platform, app_version,
      file_name, file_id, location, status, acquired_at, heartbeat_at, expires_at, last_active_at)
  values (v_uid, p_vault_key, p_device_id, v_lease, p_session_nonce, left(p_device_name, 120),
      p_platform, left(p_app_version, 40), left(p_file_name, 255), p_file_id, left(p_location, 120),
      'active', now(), now(), now() + interval '90 seconds', now())
  on conflict (user_id, vault_key, device_id) do update set
      lease_id = excluded.lease_id, session_nonce = excluded.session_nonce,
      device_name = excluded.device_name, platform = excluded.platform,
      app_version = excluded.app_version, file_name = excluded.file_name,
      file_id = excluded.file_id, location = excluded.location,
      status = 'active', acquired_at = now(), heartbeat_at = now(),
      expires_at = excluded.expires_at, last_active_at = now(),
      busy = '{}'::jsonb, flags = '{}'::jsonb, abandoned_at = null,
      displaced_by_device = null, displaced_reason = null, displaced_at = null;

  return jsonb_build_object('granted', true, 'lease_id', v_lease, 'limit', v_limit,
    'ttl_seconds', 90, 'heartbeat_seconds', 30,
    'sessions', public.vault_sessions_for(v_uid, p_vault_key, p_device_id), 'server_now', now());
end $$;

create or replace function public.vault_session_heartbeat(
  p_vault_key uuid, p_device_id uuid, p_lease_id uuid, p_active boolean,
  p_busy jsonb default null, p_flags jsonb default null,
  p_file_name text default null, p_file_id uuid default null, p_location text default null,
  p_written_vv jsonb default null, p_pending boolean default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_row public.personal_vault_sessions;
  v_limit int;
  v_by text;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_vault_key::text, 0));

  select * into v_row from public.personal_vault_sessions
   where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;
  if not found then return jsonb_build_object('status', 'lost', 'reason', 'unknown'); end if;
  if v_row.lease_id is distinct from p_lease_id then
    return jsonb_build_object('status', 'lost', 'reason', 'superseded');
  end if;

  -- Record what this lease published, whatever its status.
  update public.personal_vault_sessions set
      written_vv = coalesce(p_written_vv, written_vv),
      written_at = case when p_written_vv is null then written_at else now() end,
      abandoned_at = case when p_written_vv is null then abandoned_at else null end,
      pending_changes = coalesce(p_pending, pending_changes),
      file_name = coalesce(left(p_file_name, 255), file_name),
      file_id = coalesce(p_file_id, file_id),
      location = coalesce(left(p_location, 120), location),
      busy = coalesce(p_busy, busy),
      flags = coalesce(p_flags, flags)
   where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;

  if v_row.status = 'displaced' then
    select device_name into v_by from public.personal_vault_sessions
     where user_id = v_uid and vault_key = p_vault_key and device_id = v_row.displaced_by_device;
    return jsonb_build_object('status', 'displaced', 'reason', v_row.displaced_reason, 'by', v_by);
  end if;

  -- Never revive a released or lapsed lease (red team #31): the client must acquire again.
  if v_row.status <> 'active' or v_row.expires_at < now() then
    update public.personal_vault_sessions set status = 'expired'
     where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id and status = 'active';
    return jsonb_build_object('status', 'lost',
      'reason', case when v_row.status = 'released' then 'released' else 'expired' end);
  end if;

  update public.personal_vault_sessions set heartbeat_at = now(),
         expires_at = now() + interval '90 seconds',
         last_active_at = case when p_active then now() else last_active_at end
   where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;

  v_limit := coalesce(public.vault_device_limit(v_uid), 1);
  if v_limit <> -1 then                     -- plan limit (downgrade): keep busy, then most recently active
    with ranked as (
      select device_id,
             row_number() over (order by public.vault_session_is_busy(busy) desc,
                                         last_active_at desc, device_id) as rn
        from public.personal_vault_sessions
       where user_id = v_uid and vault_key = p_vault_key and status = 'active' and expires_at >= now()),
    keeper as (select device_id from ranked where rn = 1)
    update public.personal_vault_sessions s
       set status = 'displaced', displaced_reason = 'plan_limit', displaced_at = now(),
           displaced_by_device = (select device_id from keeper)
      from ranked r
     where s.user_id = v_uid and s.vault_key = p_vault_key and s.device_id = r.device_id and r.rn > v_limit;

    select * into v_row from public.personal_vault_sessions
     where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;
    if v_row.status = 'displaced' then
      select device_name into v_by from public.personal_vault_sessions
       where user_id = v_uid and vault_key = p_vault_key and device_id = v_row.displaced_by_device;
      return jsonb_build_object('status', 'displaced', 'reason', 'plan_limit', 'by', v_by);
    end if;
  end if;

  return jsonb_build_object('status', 'ok', 'limit', v_limit,
    'sessions', public.vault_sessions_for(v_uid, p_vault_key, p_device_id), 'server_now', now());
end $$;

create or replace function public.vault_session_release(
  p_vault_key uuid, p_device_id uuid, p_lease_id uuid,
  p_written_vv jsonb default null, p_pending boolean default false)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  update public.personal_vault_sessions
     set status = case when status = 'active' then 'released' else status end,
         expires_at = least(expires_at, now()), heartbeat_at = now(),
         written_vv = coalesce(p_written_vv, written_vv),
         written_at = case when p_written_vv is null then written_at else now() end,
         abandoned_at = case when p_written_vv is null then abandoned_at else null end,
         pending_changes = coalesce(p_pending, false)
   where user_id = auth.uid() and vault_key = p_vault_key and device_id = p_device_id
     and lease_id = p_lease_id;
end $$;

-- "Stop waiting for MacBook": exclude that session's marker until it reports a new one.
create or replace function public.vault_session_abandon(
  p_vault_key uuid, p_device_id uuid, p_target_device_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_target_device_id = p_device_id then return; end if;
  update public.personal_vault_sessions set abandoned_at = now()
   where user_id = auth.uid() and vault_key = p_vault_key and device_id = p_target_device_id;
end $$;

revoke execute on function public.vault_session_peek(uuid, uuid) from public, anon;
revoke execute on function public.vault_session_acquire(uuid,uuid,uuid,text,text,text,text,uuid,text,boolean) from public, anon;
revoke execute on function public.vault_session_heartbeat(uuid,uuid,uuid,boolean,jsonb,jsonb,text,uuid,text,jsonb,boolean) from public, anon;
revoke execute on function public.vault_session_release(uuid,uuid,uuid,jsonb,boolean) from public, anon;
revoke execute on function public.vault_session_abandon(uuid,uuid,uuid) from public, anon;
grant execute on function public.vault_session_peek(uuid, uuid) to authenticated;
grant execute on function public.vault_session_acquire(uuid,uuid,uuid,text,text,text,text,uuid,text,boolean) to authenticated;
grant execute on function public.vault_session_heartbeat(uuid,uuid,uuid,boolean,jsonb,jsonb,text,uuid,text,jsonb,boolean) to authenticated;
grant execute on function public.vault_session_release(uuid,uuid,uuid,jsonb,boolean) to authenticated;
grant execute on function public.vault_session_abandon(uuid,uuid,uuid) to authenticated;
```

**Notes.**
- `busy`, `flags` and `written_vv` are small by construction; the check constraints reject oversize values, and the client treats that error as "unconfirmed", never as a denial.
- **Realtime:** clients subscribe to `postgres_changes` UPDATE on `personal_vault_sessions` with filter `device_id=eq.<own id>`. RLS limits delivery to the user's own rows [A: Realtime applies RLS, as team sync already relies on]. An UPDATE whose `lease_id` differs from the device's own means it was superseded.
- **Phase 1** deploys this with every limit at -1, so leases are presence only.

### 9.6 `<date>_free_single_device.sql` (Phase 2)

```sql
update public.tiers set features = features || '{"vault_max_open_devices": 1}'::jsonb,
  updated_at = now() where name = 'free';
```

Turning enforcement off again is the same statement with -1. No storage-bucket change is needed; the `vaults` bucket stays at 10 MiB (3.7).

### 9.7 Verification

**Checked this pass** [V]: sections 9.2, 9.4 and 9.5 were run in a throwaway Postgres 16 with stub `auth`, `tiers` and `user_profiles` tables (`PROBES/sqltest/`). Results: a heartbeat after release returns `lost/released` and leaves the row released; a second device is granted after release; a Free third acquire is denied; take-over displaces; a second running copy with the same device id supersedes the first (`lost/superseded`); on a Pro to Free downgrade the busy device is kept and the other is displaced with `plan_limit`; abandon and peek work; an oversize `busy` value is rejected; the guard trigger lets `authenticated` change `display_name` and set a first `stripe_customer_id` but blocks `tier_id` and a second `stripe_customer_id`.

---

## 10. iOS work

### 10.1 iOS 1.0.6 safety patch (recommended before desktop GA)

Small changes that make the shipped legacy writer much safer. None of them needs the sync engine.
- `Features/Vault/EntryEditorView.swift`: merge the edited keys into the entry's existing `config` JSON instead of rebuilding it (keeps unknown keys, document `content`, RDP `sharedFolders`), and re-read the entry from the database at save time so only fields the user changed are written (today `buildEntry` writes every field from the snapshot taken when the sheet opened, `EntryEditorView.swift:579-712`) [V].
- `Core/Vault/VaultFileCoordinator.swift`: stop copying and folding source `-wal`/`-shm` in `stageFromSource`, and stop `removeCompanions(of: source)` in `writeBack`.
- `Core/Vault/VaultManager.swift`: `close()` flushes a pending write-back instead of dropping it (`:238-247`) [V]; the auto-refresh poll compares modification dates with `!=` instead of `>` (`:515`) [V].
- `Features/Vault/VaultFilePicker.swift`: use a per-source sandbox folder so an external `X.conduit` no longer wipes an in-app vault of the same name.

### 10.2 iOS 1.1: new code

**`ConduitiOS/Core/Sync/`** (each file under about 400 lines):

| File | Responsibility |
|---|---|
| `HLC.swift`, `Dot.swift`, `VersionVector.swift` | Clocks, dots, vv, rank |
| `SyncSchema.swift` | 3.3 DDL, `sync_format` check, `password_history` |
| `SyncStore.swift` | Raw GRDB `Row` SQL for rowkeys, registers, implicit registers, siblings, graves (never Codable structs, so unmodeled columns such as `parent_entry_id` survive) |
| `Canonical.swift` | `canon`, RFC 8785 JCS, timestamp parsing |
| `Hashing.swift` | `vhash`, `pid`, `raw_hash`, HKDF, key check values (CryptoKit) |
| `CaptureLocal.swift` | Local capture, rule R, cascade rule H, `prev_vhash`, publish marker |
| `CaptureLegacy.swift` | Legacy capture with the drop, hold and stale-revert rules |
| `Genesis.swift` | G1, G2, G3 |
| `Candidates.swift` | Replica and synthetic candidates, previews |
| `Merge.swift` | `mergeRegister`, `merge`, guards, conflict test |
| `Materialize.swift` | Rows, containers, cycles, foreign-key order |
| `KeyEpoch.swift` | Epochs, wraps, alignment, unlock policy, redaction |
| `SharedFile.swift` | Coordinated read, classify, CAS publish, mtime bump |
| `SyncEngine.swift` | Loop, single flight, `commitMerge`, backoff, status |
| `DeviceIdentity.swift` | Keychain device id, session nonce, incarnation, high-water check |
| `ReplicaStore.swift` | Lineage folder, `local.json` |
| `Tombstones.swift`, `Conflicts.swift` | Recently deleted, redaction, `listConflicts`, resolutions |

**`Core/Networking/`:** `VaultSessionService.swift` (the five RPCs through supabase-swift `.rpc`, plus Realtime; iOS uses neither today, ios-app section 3), `VaultAccessCoordinator.swift` (6.3), `EffectiveLimit.swift`, `OwnerClaims.swift`.

**`Features/Vault/`:** `ConflictReviewView.swift`, `ConflictBanner.swift`, `TakeoverSheet.swift`, `DisplacedView.swift`, `WaitingForDriveView.swift`, `PasswordChangedElsewhereView.swift`, `CandidateMergeView.swift`, `RecentlyDeletedView.swift`, `FileVersionReviewView.swift`.

### 10.3 iOS 1.1: changes to existing files

- `Core/Vault/VaultManager.swift`:
  - `open`, `openWithKey`, `createVault` (128-222): gate through `VaultAccessCoordinator`, lineage working copy, genesis, first-launch absorption.
  - Every mutator (331-442): `capture` in the same `dbQueue.write`, bumping the in-memory generation.
  - `performRefreshFromSource` (556-680): replace the wholesale swap and the "discard staged on local edit" branch (`:624-631`) [V] with classify, absorb, align, merge and `commitMerge`.
  - `performWriteBack` (718-754): CAS publish with the mtime bump.
  - `close()` (238-266): flush with a background task instead of dropping `pendingWriteBack` [V].
  - `startAutoRefresh` (500-521): `!=` plus a hash, plus the heartbeat.
- `Core/Vault/VaultFileCoordinator.swift`: add `readSourceBytes()` and `writeBackIfUnchanged`; drop `removeCompanions(of: source)` [V]; `stageFromSource` stops copying source `-wal`/`-shm` (`:212-220`) [V]; `commitStagedIntoSandbox` (253-267) is replaced by merge into W; add the `NSFileVersion` pass.
- `Features/Vault/VaultFilePicker.swift:50-87`: open or create the lineage working copy instead of delete-and-copy.
- `Features/Vault/VaultTab.swift:197-220, 268-288`: open and restore go through `VaultAccessCoordinator`.
- `Features/Vault/EntryEditorView.swift`: the 10.1 fixes, plus the conflict-aware editor (interactive writes replace all siblings).
- `App/ConduitApp.swift:24-39, 56-67` and `Core/Vault/AutoLockManager.swift:47-79`: background (final sync, then release) and foreground (re-acquire) (6.10).
- `Core/Networking/ProfileService.swift:19-33` and `TierGating.swift:12-49`: read `vault_max_open_devices` for wording.
- `Core/Vault/VaultMigrations.swift`: keep `latestSchemaVersion = 10`; set `creationSchemaVersion = 10`; add the `sync_format` check separate from the schema version.
- Copy updates: `WelcomeView.swift:106-116`, `VaultSourceView.swift:277-294`, `CreateVaultView.swift:34` (ios-app 4a.11).

### 10.4 First 1.1 launch

- If `Documents/<name>` from 1.0.5 exists for a source whose lineage or salt matches:
  - **It has sync tables** (desktop shipped first, so usually): replica candidate (4.9). A pure stale cache yields zero changes; only real unsynced edits appear (red team #19).
  - **It is pre-sync:** synthetic candidate filtered to rows newer than the source's matching row.
  - Label: "Changes found on this iPhone". Preview before merging if it contains anything.
- Afterwards move it to `Application Support/Vaults/<lineage>/legacy-sandbox-<date>.conduit` (kept 30 days).
- 1.0.5 deletes and re-copies the sandbox on every open (`VaultTab.swift:210, 276`) [V], so most sandboxes contribute nothing.

### 10.5 iOS-specific behavior

- iOS has no password-change feature; it needs only the receiving side of 4.8.
- iOS cannot see sibling files [A, critic C6]: it relies on the server side-file flag when signed in (5.5) and on `NSFileVersion` for iCloud conflicts [A].
- A displaced iPhone soft-locks the vault; open SSH sessions keep running.
- `VACUUM INTO` needs system SQLite 3.27 or later [A: iOS ships newer].

---

## 11. Desktop implementation plan

Keep every new file under about 400 lines. Existing large files (`vault.ts`, `database.ts`, `ipc/vault.ts`) get thin hooks only; the logic lives in new modules.

### 11.1 New main-process modules

**`electron/services/sync/`**

| File | Responsibility | Target lines |
|---|---|---|
| `paths.ts` | `syncRoot` per platform, per-machine folder, network check, `realpath` and shared-versus-private | 150 |
| `identity.ts` | `device.json`, `hw_hint` (with Linux machine-id), session nonce, incarnation and `dev`, high-water check | 200 |
| `local-state.ts` | `local.json` schema, validation, atomic writes, repair | 200 |
| `schema.ts` | 3.3 DDL, `sync_format` check, `password_history` fix | 150 |
| `canonical.ts` | `canon`, JCS, timestamp parsing | 250 |
| `hashing.ts` | `vhash`, `pid`, `raw_hash`, HKDF labels, key check values | 200 |
| `hlc.ts` | HLC, dots, vv operations, rank | 150 |
| `state-store.ts` | Load and save state: rowkeys, explicit and implicit registers, siblings, graves, epochs, wraps | 350 |
| `capture-local.ts` | Local capture, rule R, cascade rule H, `prev_vhash`, publish marker | 350 |
| `capture-legacy.ts` | Legacy capture, drop, hold and stale-revert rules, delete times | 350 |
| `genesis.ts` | G1, G2 baseline absorb, G3 adoption | 300 |
| `candidates.ts` | Replica and synthetic candidates, preview model | 350 |
| `merge.ts` | `mergeRegister`, `merge`, guards, conflict test | 300 |
| `materialize.ts` | Rows, containers, cycles, foreign-key order, graves | 350 |
| `key-epoch.ts` | Epochs, wraps, alignment, unlock policy, redaction | 350 |
| `rekey.ts` | Password change on new builds; legacy password change flow | 250 |
| `shared-file.ts` | Read, classify, CAS publish, mtime bump, tmp cleanup | 300 |
| `file-watch.ts` | Directory watch, stat poll, hash poll | 150 |
| `side-files.ts` | Side-file states, confirmation, hold rule, server flag | 250 |
| `copy-scanner.ts` | Same-folder scan, classification, provider patterns | 300 |
| `file-binding.ts` | Binding, `file_id`, missing-file debounce, rebind, separate-vault fork | 300 |
| `divergence.ts` | Cross-device "different copies" detection | 150 |
| `snapshots.ts` | Pre-merge snapshots, `diff.json`, targeted undo | 300 |
| `restore.ts` | Rollback with preview, restore as new vault | 250 |
| `tombstones.ts` | Recently deleted, restore, delete permanently | 200 |
| `conflicts.ts` | `listConflicts`, resolutions, snooze | 300 |
| `sync-engine.ts` | Loop, single flight, `commitMerge`, backoff | 350 |
| `sync-status.ts`, `notices.ts` | Status model and events; local notices | 120 each |
| `__vectors__/*.json`, `__tests__/*` | Golden vectors and tests (13) | |

**`electron/services/vault-session/`**

| File | Responsibility | Target lines |
|---|---|---|
| `session-client.ts` | RPC wrappers; network versus server-error classification | 250 |
| `heartbeat.ts` | Timers, `powerMonitor`, busy and flag reporting | 200 |
| `realtime.ts` | Own-row subscription, superseded detection | 120 |
| `effective-limit.ts` | 6.8 limit resolution and cache sanity | 150 |
| `claims.ts` | Owner claim writing and evaluation (6.7) | 200 |
| `stale-wait.ts` | Expected markers, abandon | 150 |
| `open-personal-vault.ts` | The 6.3 unlock sequence | 350 |
| `displacement.ts` | Final sync, soft lock, modal events | 200 |

**IPC:** `electron/ipc/sync.ts` (`sync_get_state`, `sync_now`, `sync_list_devices`, `sync_list_copies`, `sync_copy_action`, `sync_confirm_side_files`, `sync_locate_file`, `sync_make_separate_vault`, `sync_export_unsynced`, `vault_session_takeover`, `vault_session_stop_waiting`) and `electron/ipc/sync-review.ts` (`sync_list_conflicts`, `sync_resolve`, `sync_resolve_group`, `sync_candidate_preview`, `sync_candidate_apply`, `sync_held_apply`, `sync_undo_preview`, `sync_undo_apply`, `sync_recently_deleted`, `sync_restore_deleted`, `sync_delete_permanently`). Events: `sync:state-changed`, `sync:conflicts-changed`, `sync:notice`, `vault:session-displaced`.

### 11.2 Changed main-process files

| File | Change |
|---|---|
| `electron/services/env-config.ts` | Ignore `CONDUIT_ENV` when `app.isPackaged` (`:55-66`) [V]; add `getSyncRoot()` |
| `electron/services/auth/fingerprint.ts` | Linux branch reading `/etc/machine-id` or `/var/lib/dbus/machine-id` (today it falls back to the hostname) [V] |
| `electron/services/auth/supabase.ts` | `loadCachedTierCapabilities` rejects timestamps more than 5 minutes in the future (`:705-721`) [V] |
| `electron/services/vault/vault.ts` | Working path versus shared path; a `SyncHooks` interface called inside mutator transactions; `changePassword` delegates to `sync/rekey.ts`; `rekey` stops stamping `updated_at` (`:1179`); `reloadFromDisk` retired for personal vaults; `getVaultId` eager |
| `electron/services/vault/database.ts` | Run sync DDL including `password_history`; a transaction wrapper that calls the capture hook; `vacuumInto`; journal-mode option for network roots |
| `electron/ipc/vault.ts` | All nine unlock paths call `openPersonalVault`; `wireBackupServices` starts the SyncEngine instead of `startVaultWatcher` and re-checks the backup tier; `vault_rename` rebinds; a new `softLockVaultFromMain` next to `lockVaultFromMain` |
| `electron/ipc/biometric.ts` | Same gate (`:59-83`) |
| `electron/services/vault/biometric.ts` | Key by lineage; move the old file on first unlock |
| `electron/ipc/cloud-sync.ts`, `electron/ipc/local-backup.ts` | Restores become rollback-with-preview or new vault; tier checks on restore |
| `electron/services/vault/cloud-sync.ts`, `local-backup.ts` | Back up a `VACUUM INTO` snapshot of W; deflate above 10 MiB (`0x02`) |
| `electron/services/state.ts` | `switchVault` tears down sync, session and backups (`:240-245`); soft-lock support that clears the vault without `closeAllSessions` |
| `electron/main.ts` | Bounded flush and release on `before-quit` (`:1000-1034`); `powerMonitor` suspend and resume |
| `electron/services/vault/network-lock.ts` | `isNetworkPath` gains `CloudStorage`, iCloud for Windows, Box, Nextcloud, Synology |
| `electron/services/vault/network-watcher.ts` | Retired for personal vaults (replaced by `sync/file-watch.ts`) |
| `electron/ipc-server/server.ts` | `has_conflict` in `entry_info` and `credential_read`; locked reason `open_elsewhere` |
| `electron/ipc/ai.ts` | `vault_max_open_devices` in tier capabilities |

### 11.3 Renderer

- `src/stores/vaultStore.ts`: parse structured unlock errors.
- New `src/stores/syncStore.ts`.
- New `src/components/sync/`: `PersonalSyncIndicator.tsx`, `ConflictReviewPanel.tsx`, `ConflictFieldRow.tsx`, `TakeoverDialog.tsx`, `DisplacedDialog.tsx`, `WaitingForDriveDialog.tsx`, `PasswordChangedElsewhereDialog.tsx`, `CandidateMergeDialog.tsx`, `OtherCopiesPanel.tsx`, `SideFilesPausedBanner.tsx`, `RecentlyDeletedPanel.tsx`, `MassChangeNotice.tsx`, `DifferentCopiesDialog.tsx`.
- `src/App.tsx`: listeners for the new events.
- Re-word `src/components/vault/ProVaultLockDialog.tsx`, `src/components/settings/tabs/MobileTab.tsx:82` and the Backup tab's plan badge.
- All status messages use the toast system (repo convention).

### 11.4 Desktop 0.17.x safety patch (recommended before desktop GA)

- For vaults where `isNetworkPath` is true: close the database after 30 minutes idle and reopen on demand, so an idle old desktop leaves no side files.
- The watcher treats a changed inode as a change and compares mtimes with `!=`.
- Checkpoint after `vault_meta` writes (fixes the salt stuck in the WAL).

### 11.5 Docs

- Add a `docs/FEATURES.md` entry (repo convention) and update `docs/SUPABASE.md` with the new table and RPCs.

---

## 12. Failure scenarios

"Merge" means section 4. "Republish" means 5.6 and 5.7. Rows 39 to 70 come from the red-team review.

| # | Scenario | Outcome |
|---|---|---|
| 1 | A and B change `host` offline for 3 days, to different values | Two dots, neither covers the other: two siblings, a prompt conflict. Every device shows the higher-rank value with an amber marker. The user's choice covers both and replaces them everywhere after one sync. |
| 2 | A edits `host`, B edits `notes` on the same entry | Different registers, both applied, no conflict. `updated_at` is the later dot's time. |
| 3 | A deletes entry E; B, offline, renames E | B's rename re-asserts `live`, not covered by A's delete: `_life` holds both. E stays visible with B's name. Review: "Deleted on MacBook, edited on iPhone" [Keep item] [Delete item]. |
| 4 | A deletes folder F recursively; B adds entry N inside F | B's create re-asserts F. F conflicts and stays visible with N. A's other deletions in F stay deleted. |
| 5 | A moves X under Y; B moves Y under X | Both win and form a cycle. Materialization puts the highest-rank mover at top level, identically everywhere. A structural conflict offers the three choices. |
| 6 | A's clock is 2 hours fast | Causality uses vv and pmem, so conflicts are still detected. A's values win provisional picks. Others' HLCs follow A (24 h cap). `updated_at` may show future times. |
| 7 | Cloud drive silently keeps B's upload over A's, both online | A's 15 s check finds S no longer covers its publish; A merges B's content and republishes. Converges within two cycles. Nothing lost. |
| 8 | Same as 7, but A is closed for a week right after | A's edits wait in W. B sees A's publish marker uncovered: banner (Pro) or wait dialog with [Open now] (Free). A republishes at its next unlock. |
| 9 | "Vault-DESKTOP-ABC.conduit" appears, made by OneDrive between two new-build desktops | Class 3: only uncovered app dots and a provider pattern. Merged automatically, toast, the copy stays in place. |
| 10 | iOS 1.0.5 edits `notes` while desktop is open | Row hash, then register hash, shows `notes` changed: a pseudo sibling covering what iOS saw. A concurrent desktop edit makes a conflict; otherwise it applies. |
| 11 | iOS 1.0.5 blindly writes its stale sandbox plus one edit over a newer publish | Absorbed against the stale tables it carries: only its own edit is new. Desktop's newer dots survive; desktop republishes with the mtime bump, and iOS 1.0.5 pulls it on its next poll. |
| 12 | Password changed on desktop 0.18; iOS 1.0.5 (old key) then saves a password | Fails under the current key; the wrap chain yields K1; absorbed re-encrypted under K2. If no key works: undecryptable sibling plus notice. Never dropped. |
| 13 | Desktop 0.17 edits S in place on another computer; its side files sync | Its edits are absorbed from the main file. Side files present: publishing paused, its deletes and stale reverts held for review. Our edits stay in W. |
| 14 | 0.17 on this computer quit while unlocked, leaving `-wal`/`-shm` | "Present" state with upgrade wording; one click [Continue] moves them aside and publishes. A non-empty WAL goes through review first. |
| 15 | Password changed on A (new build) while B has 5 unsynced edits | B sees a newer epoch: keeps working, pauses publishing. New password: unwrap K1, rekey W, merge. All 5 edits kept. |
| 16 | Password changed on 0.17; a new device knows only the new password and has unsynced secret edits | Legacy change detected. Non-secrets absorbed precisely. W's unpublished secrets become undecryptable siblings with [Enter previous password] [Discard]. Nothing lost silently. |
| 17 | A and B both change the password offline | The `epoch` register conflicts; devices that can't read both pause. The user enters the other password once and picks; the loser is wrapped under the winner. |
| 18 | Torn S (iOS write killed; cloud still downloading) | Unreadable: retry 5, 15, 45 s. After 2 minutes with the same bytes: quarantine and republish from W. The torn writer republishes its own edits. |
| 19 | Vault renamed or moved on another device | Missing for 30 s: one same-lineage file with a normal name is rebound (toast, Undo); otherwise [Locate...]. Edits continue in W. Never recreated at the old path. |
| 20 | User copies Vault.conduit to "Vault backup.conduit" and opens the copy | Same-device copy prompt. [Use as a separate vault] writes a new file with a new lineage; the copy is left untouched. |
| 21 | A and B each create a folder "Servers" | Different ids, both kept. Suggestion [Merge folders] [Keep both]. |
| 22 | App crash mid-write | W: transaction, all or nothing. Desktop publish: tmp, fsync, rename. iOS in place: row 18. Capture re-runs at start. |
| 23 | Mac, Windows and iPhone edit and gossip in any order | Commutative, associative, idempotent merge: same rows and conflicts everywhere. |
| 24 | Pro becomes Free while MacBook, Windows PC and iPhone are open | Next heartbeat: keep the busy device, then the most recent; others displaced (`plan_limit`), final sync, soft lock. Conflicts stay reviewable. [V SQL] |
| 25 | Free becomes Pro mid-session | Next heartbeat returns -1; prompts and claims stop. No data changes. |
| 26 | Free, signed in: B opens before the drive delivered A's publish | A's marker not covered: "Getting the latest version from MacBook..." with [Open now] from the start; continues on its own. |
| 27 | Free: B takes over while A is asleep and offline | Server displaces A. A wakes offline and keeps working. On reconnect: `displaced`, final sync, soft lock. |
| 28 | Free: two signed-out devices opened minutes apart | The later opener sees the earlier claim (if delivered) and gets the dialog, or claims silently. The highest claim wins everywhere; the other is displaced on its next merge. Edits merge. |
| 29 | Free: signed-in desktop open; the same person opens it on a signed-out iPad | The iPad sees the desktop's claim and presence: dialog. "Use here instead" writes a claim with `a = null`; the desktop honors it (a claim from a device without a lease) and soft-locks. |
| 30 | Mac cloned with Migration Assistant, or W restored from Time Machine | Every launch has a new incarnation, so no dot is reused. A clone also gets a new `device_uuid` (hw_hint differs). |
| 31 | A deletes credential C; B links connection K to C | B's link re-asserts C: `_life` conflict. C stays live; the link works. |
| 32 | A stale `-wal` from another machine arrives next to a newer S | Never read. "Present" state: publishing paused, deletes and reverts held. Review as a private candidate or move aside. |
| 33 | Cloud delivers a replaced S with an older or equal mtime | `!=` on (size, mtime, inode) plus a 60 s hash detects it. Merge results never depend on mtimes. |
| 34 | A real mass delete of 42 items | Snapshot with diff. "MacBook deleted 42 items." [Undo] re-creates only those 42, with preview. |
| 35 | Supabase down for a signed-in Free user | Unconfirmed: the vault opens; claims apply; the lease settles on reconnect. |
| 36 | The same document edited on two devices | `config.content` conflict with a diff; [Keep both] creates "Doc (from iPhone)". |
| 37 | Two new-build devices migrate the same legacy file, or different pre-sync versions | Same bytes: identical genesis. Different versions: G3; the shared file's genesis wins, the other's newer differences become labeled conflicts. |
| 38 | A device returns after 7 months with edits to a row deleted elsewhere | Tombstones are kept, so its edit re-asserts `live` against the delete: a normal `_life` conflict restoring from the grave. |
| 39 | Mac restored from a Monday Time Machine backup (W and the local cloud folder), edited offline on Tuesday, then the real S arrives | Tuesday's launch uses a new dev. Monday 10:00 dots in S are not covered by W's old vv, so they are kept; Tuesday's edits are kept. Nothing vanishes. (#1) |
| 40 | Wall-clock purge timing across devices | There is no time-based purge; the delete stays a tombstone and a late edit makes a conflict. (#2) |
| 41 | iOS 1.1 absorbs a 1.0.5 sandbox holding an edit the Mac already absorbed at 09:00, plus an unsynced 12:00 edit | Replica candidate: the 09:00 edit dedups, the 12:00 edit becomes a normal pseudo sibling (or a conflict). Nothing is dropped. (#3) |
| 42 | User makes "Vault 2.conduit" with Files > Duplicate and deletes 15 entries in it on iOS 1.0.5 | Not a provider pattern and has legacy deletes: class 4 notice with review. Nothing merged or moved without consent. (#4, #14) |
| 43 | User clicks Undo on a mass-delete notice two days later | Only the rows that merge deleted are offered back, with a preview; later edits elsewhere are untouched. (#5) |
| 44 | Windows on 0.20 publishes `sync_format 2`; the Mac is on 0.19 | Foreign (newer format): the Mac stops publishing to that path and asks to update. No overwrite loop. (#6) |
| 45 | iPhone 1.0.5 editor is open while the Mac changes `host`; the user saves a notes change | The saved row carries the old `host`, equal to the Mac edit's `prev_vhash`: stale-revert conflict, the Mac's value stays provisional. (#7) |
| 46 | User renames a document on iOS 1.0.5 (config becomes `{}`) | Drop rule: the text is kept, a notice appears, S gets a repair publish. (#7) |
| 47 | The user saves a password on iPhone 1.1 while a 1 s merge runs | `commitMerge` sees the generation change and re-joins; the new password and its dot survive. (#8) |
| 48 | Mac syncs iCloud/Vault.conduit, Windows syncs a copied OneDrive/Vault.conduit | Different provider in the session rows: "These are separate copies" prompt with [Merge them...]. Signed out: not detectable (6.13). (#9) |
| 49 | 0.17 on Windows quits unlocked with a non-empty WAL; iPad 1.0.5 folds it and writes a mixed file | Side files present on the Mac: its deletes and reverts are held for review; the server flag makes iOS 1.1 hold them too. (#10) |
| 50 | iPhone 1.0.5 edits E; Windows 0.17, with stale tables, deletes E two minutes later | The delete's time comes from the observed file time, so it follows the legacy clock and wins, as today. (#11) |
| 51 | 0.17 left unlocked over a weekend in a Google Drive folder | Side files present: publishing stays paused until the user confirms. No rename over its live connection. (#12) |
| 52 | File at the bound path now has another lineage | Foreign: stop publishing, prompt [Locate...]. Never overwritten, no ping-pong. (#13, #26) |
| 53 | Domain user with a roaming profile signs in on two PCs | Working copies live in LOCALAPPDATA under a per-machine folder; no shared or overwritten W. (#15) |
| 54 | Beta user turns Labs off with a day of paused edits | Toggle blocked: [Publish now] or [Export unsynced changes]. (#16) |
| 55 | Linux VM cloned after Conduit ran (same machine-id) | Each launch gets its own dev, so no dot collides. The server sees the same device id with another nonce: the newer copy supersedes the older, which soft-locks. (#17, #28) |
| 56 | iOS 1.0.5 writes a pre-sync sandbox over S after the first genesis | G2: salt check, then baseline absorb from `genesis.conduit`, or candidate review. Genesis never re-runs; deleted rows do not come back. (#18) |
| 57 | First iOS 1.1 launch with a stale 1.0.5 sandbox | Replica candidate against its own tables: zero changes, no stale conflicts. (#19) |
| 58 | OneDrive renames the local file to "Vault-PC1.conduit" and puts the server version at "Vault.conduit" | 30 s debounce sees the original name return; no rebind to a conflict name. (#20) |
| 59 | Someone types the old master password after a rotation | Rejected. Old verifiers are redacted from the file, so once a device reads the changed state the old password gets the plain "Invalid master password". Only while the shared file is from before the change (an older file the cloud drive brought back) does it say "Your master password was changed on MacBook." and delete a biometric entry holding the old password. A device that has not seen the change yet opens only its own working copy with the old password and pauses syncing until the new one is entered. (#21, #27) |
| 60 | Desktop clock 5 minutes behind the iPhone | The publish mtime is at least S's mtime plus 2 s, so iOS 1.0.5 and 0.17 pull it. (#22) |
| 61 | A 9,000-entry vault | About 10 MiB. Cloud backup uses `0x02` above 10 MiB; legacy apps cannot restore those (documented). (#23) |
| 62 | Free user blocks the Supabase host on both computers | Both unconfirmed: claims honored, including same-account ones. One device at a time. (#24) |
| 63 | `default.conduit` symlinked into Dropbox on two Free computers | `realpath` says shared: lease, claims and W apply. (#25) |
| 64 | 0.17 changes the password before the Mac's first publish | G2 salt check: legacy password flow asks for the new password. The change is kept; S is never republished with the old salt. (#26) |
| 65 | Old master password leaked; the user rotates it and erases Recently deleted | New epoch; old verification and salt redacted; secret pids never derive from plaintext; graves erased. (#27) |
| 66 | Phone takes over while the desktop runs an overnight RDP job | The dialog shows "3 open connections, 1 AI task". Soft lock: the job keeps running; only the vault locks. (#29) |
| 67 | iPhone wiped after publishing a marker the cloud never kept | [Open now] from the start; [Stop waiting for iPhone] abandons that marker server-side. (#30) |
| 68 | A heartbeat arrives after release | `lost/released`; the row stays released; a new acquire is required. [V SQL] (#31) |
| 69 | A long-lived vault with hundreds of launches | The file vv grows about 30 bytes per launch; the server marker stays one entry. (#32) |
| 70 | A device's clock was 30 days fast once; a tampered wrap is in the file | Presence rows merge by dots; future `last_active_ms` is ignored for prompts. Invalid wraps are ignored; the valid one still unlocks. (#33, #34) |

---

## 13. Test plan

### 13.1 Unit and property tests (vitest on desktop, XCTest on iOS)

**Golden vectors** in `DESK/electron/services/sync/__vectors__/*.json`, copied into the iOS test bundle by a script. Byte-identical outputs for: `canon` (JCS, timestamps), both `vhash` forms, keyed `pid` (non-secret and ciphertext-based secret), the zero implicit pid, `raw_hash` (a vector proving that re-encrypting the same secret changes `raw_hash` and that the per-register compare reports no change; no plaintext input), `dev`, `lineage_id`, `genesis_id`, `account_hint`, `epoch_id`, HKDF outputs, HLC tick, receive and cap.

**Same semantic results** for: coverage, `mergeRegister`, implicit registers, provisional choice with `lt`, conflict detection; capture (local, legacy, genesis, rule R, rule H, drop, hold, stale revert, delete times, stale-key secrets); materialization (cycles, dangling references, containers, foreign-key order, `updated_at`); epochs (wrap validation with explicit targets, rekey, alignment, legacy change with and without the old key, concurrent changes, redaction, unlock policy rejecting ancestors); candidates (replica, synthetic with fresh dev, newer-only filter, no minted deletes); redaction wins.

**Property tests** grow from `PROBES/register-sim.mjs` (fast-check in TS; a seeded generator over the same corpus in Swift), 2 to 6 replicas, random operations. Checks: commutativity, associativity, idempotence, convergence under random gossip, and the no-lost-write oracle. Extensions: rule R, non-interactive partial replacement, whole-row state, deletes and tombstones (no GC), implicit registers, per-launch devs with restores (a replica rolls back to an old snapshot and continues: must never lose a dot), synthetic candidates imported on several replicas, redaction, epoch and wrap union laws, materialization invariants (no cycles, no dangling live references, deterministic across merge order). A regression test keeps a "collapse equal values" variant that must fail, and a "reuse dev after restore" variant that must fail.

**Legacy fixtures:** iOS 1.0.5 patterns (whole-row update without `parent_entry_id`, rebuilt `config` for every entry type, stale editor snapshot including secrets, SET NULL folder delete, cascaded history, GRDB date strings, empty strings, stale-key secrets, companion folding); desktop 0.17 patterns (re-encrypt on every update, `rekey` bumping `updated_at`, in-place WAL, a password change whose salt is stuck in the WAL).

### 13.2 Integration tests (real better-sqlite3, temp folders)

- **`SyncHarness`:** 2 to 4 simulated devices, each with its own `syncRoot`, `device.json`, working copy and SyncEngine, sharing one "cloud" folder through per-device mirrors.
- **`FakeCloud` adversary:** delayed or reordered delivery; silent last-writer-wins; provider-named conflict copies (Dropbox, OneDrive, iCloud, Google Drive, Syncthing) and user-style names ("Vault 2", "Vault (1)"); torn delivery; older or equal mtimes; independent `-wal`/`-shm` delivery; rename failing with `EBUSY`/`EPERM`; the OneDrive rename dance; a restore of a device's W plus its mirror to an older snapshot.
- **One named test per row of section 12** (T-FS-1 to T-FS-70).
- **Legacy writer drivers:** the vendored 0.17 `ConduitDatabase`/`ConduitVault` editing S in place (including idle with an open connection); an iOS 1.0.5 emulator reproducing stage (with companion folding), the stale editor save, rebuilt config, and in-place `writeBack` with `removeCompanions`. T-LEG-1: iOS 1.0.5 editing continuously against desktop for 5 minutes; assert no loss outside the documented CAS-to-rename gap and convergence once idle.
- **Race tests:** a capture committed between merge compute and commit (T-RACE-1, desktop and iOS); two devices importing the same candidate.
- **Cross-platform exchange in CI:** desktop writes fixture files; iOS XCTest opens them with the real GRDB code and edits them as 1.1 and as 1.0.5 (code at tag 1.0.5); desktop absorbs them back. Gate in both repos on any change under `sync/`.
- **Supabase SQL tests** (local stack, two user JWTs): acquire, deny, take-over, heartbeat, late heartbeat after release, expiry, superseded nonce, `plan_limit` with busy preference, upgrade, markers, abandon, `too_many_sessions`, parallel acquires (advisory lock), oversize JSON rejection, RLS (no reads of other users' rows, no direct writes), Realtime delivering only own rows, and the guard trigger (as run in 9.7, plus the service role and the SECURITY DEFINER team trigger unaffected).
- **Client enforcement tests:** effective limit with a future-dated cache, an expired cache, a Pro cache, and server errors; `CONDUIT_ENV` ignored when packaged; claims honored when unconfirmed, including same-account; soft lock keeps a terminal session and an RDP session running while vault IPC and MCP calls fail with `open_elsewhere`.
- **Platform tests:** `syncRoot` resolution on each OS; Linux machine-id; a network `syncRoot` switching W to DELETE mode.
- **Fault injection:** `kill -9` during a W transaction and during publish; `ENOSPC`; `EACCES`; a network drop mid-heartbeat; a clock jumped backward.

### 13.3 End-to-end and manual

- **Playwright-electron,** two app instances with separate `syncRoot`s on one temp folder: same-field conflict, review, resolve, propagation; take-over and displaced dialog (with an open terminal that survives); stale-file wait with Open now and Stop waiting; side-file pause and confirmation; copy notice and review; targeted undo.
- **Manual device matrix** before GA, across macOS, Windows and iPhone: iCloud Drive, OneDrive (including the open-file `EPERM` and its conflict renaming), Dropbox, Google Drive (`~/Library/CloudStorage/GoogleDrive-*`), an SMB share, a Windows roaming profile. Measure: conflict-copy naming, mtime behavior, whether `-wal` is synced, rename during upload, evicted placeholders, `NSFilePresenter`/`NSFileVersion` and sibling visibility under a file-only scope, sleep and wake, quit during sync, airplane mode, Time Machine restore.
- **Performance budgets** for a 5,000-entry vault: capture full pass on desktop under 100 ms; merge plus materialize on desktop under 300 ms; on an iPhone 12 under 1 s; publish snapshot under 500 ms; file size under 6 MB.

---

## 14. Rollout

| Phase | Ships | Gate or metric |
|---|---|---|
| 0 (now) | MCP quota removal (this branch). Migration 9.2 (after checking live grants). Migration 9.3 (all plans unlimited, `cloud_sync_enabled` explicit, `personal_sync = on`). Backend team override key. `CONDUIT_ENV` packaged fix and cache-timestamp sanity in the current desktop release. | Quota gone; no self-upgrade possible |
| 0.5 (recommended) | iOS 1.0.6 (10.1) and desktop 0.17.x (11.4) safety patches | Adoption of the patched builds |
| 1: desktop 0.18 beta | Engine behind Settings > Labs "Multi-device sync" (opt-in); kill switch `personal_sync = paused`. Working copies, legacy absorption with the safety rules, conflict UI, copy scanner, candidates, snapshots and targeted undo, side-file rule, tombstones, `password_history` fix. Migrations 9.4 and 9.5 deployed; leases are presence only; claims written but not enforced. | Counts-only telemetry: `sync.cycle`, `sync.conflict_created{class}`, `sync.legacy_absorbed`, `sync.legacy_dropped`, `sync.legacy_held`, `sync.stale_revert`, `sync.republish_overwrite`, `sync.torn`, `sync.foreign`, `sync.copy_class{1-4}`, `sync.epoch_mismatch`, `sync.side_file_pause`, `sync.invariant_violation`, `sync.dev_collision`, `session.rpc_error`. Zero data-loss reports and zero invariant violations over 4 weeks. |
| 2: desktop 0.19 GA | Engine on for every personal vault (automatic genesis at unlock). Free enforcement on desktop: migration 9.6; signed-out and unconfirmed claims enforced; soft lock. Wording excludes iOS. | Conflict rate and support tickets within targets |
| 3: iOS 1.1 | Swift engine, lineage working copy, CAS publish with mtime bump, lease and claims, conflict UI, `NSFileVersion` review, 1.0.5 sandbox absorption | Cross-platform fixture suite green |
| 4 | Wording "one device at a time" on every platform. "Update Conduit on your other devices" prompts driven by legacy detection. Optional: the server rejects concurrent sessions from `app_version < 1.1`. `sync_format 2` (packed rows, vv compaction, purge under causal stability) if p95 size exceeds 5 MB. Website pricing edits `fallback.ts` (critic B21). | 1.1 adoption; size distribution |

**Rollback:** sync-format files stay readable by old apps (schema 10). Turning enforcement off is one `tiers` update. Pausing sync is one `personal_sync` update, and working copies keep every edit.

---

## 15. Open questions

### 15.1 Product decisions for the owner

1. **Merge engine on Free.** Needed so a Free user moving between devices never loses an edit. Recommended: yes.
2. **Soft lock on displacement.** The vault locks, but open connections and running AI jobs keep going. Recommended: yes; closing everything kills live work.
3. **Safety patches** iOS 1.0.6 and desktop 0.17.x before desktop GA. Recommended: yes; they remove most of the legacy-writer risk.
4. **One-time confirmation** before publishing next to an old desktop's leftover `-wal`/`-shm`, with no automatic resume. Recommended: yes; an idle old desktop cannot be told apart from a crashed one.
5. **Free enforcement on desktop** in Phase 2, before iOS 1.1 (iOS 1.0.5 cannot be enforced). Recommended: yes.
6. **Offline Pro:** honor a cached Pro plan for up to 7 days when our server is unreachable. Recommended: yes; the alternative gives firewalled Pro users Free behavior.
7. **Deleted items keep a small tombstone** (about 0.6 KB each) until "Delete permanently". Recommended: yes; automatic purging lost data.
8. **Appearance fields** (icon, color, favorite, tags) go to the queue with "Keep newest" preselected, rather than resolving silently. Recommended: yes.
9. **Desktop idle auto-lock.** Without it, an idle unlocked desktop holds the Free slot until another device takes over. Recommended: offer it as a setting, off by default.

### 15.2 Assumptions to test

1. GRDB `update` leaves unmodeled columns (`parent_entry_id`) untouched, and GRDB ignores unknown tables.
2. GRDB's default date text format, and how it parses ISO strings ending in "Z".
3. Cloud-provider behavior (critic C3): conflict copies versus silent last-writer-wins, mtime preservation (the mtime bump relies on it), whether `-wal` is synced, Windows OneDrive locks.
4. `NSFilePresenter`, `NSFileVersion` and sibling visibility under a file-only scope (critic C6). The hold rule for iOS 1.1 depends on the server flag, not on this.
5. iOS bookmarks follow renames within one provider.
6. iOS supports `VACUUM INTO` (system SQLite 3.27 or later).
7. pg_cron is enabled in prod, and Realtime applies RLS to `postgres_changes`.
8. Live `user_profiles` column privileges, and whether the live `sync_is_team_member` is still `SECURITY DEFINER`.
9. Live `tiers.features` values and prod drift since 2026-04-17 (critic C1, C7). Migration 9.3 uses `||`, so it is safe either way.
10. Electron's `appData` is Roaming AppData on Windows, and `%LOCALAPPDATA%` is not redirected in typical domain setups.

### 15.3 Verified in this pass [V]

- The register rule's algebraic laws and the no-lost-write oracle: `PROBES/register-sim.mjs`, 3 seeds x 3,000 runs, 0 failures.
- SQLite applies a mismatched `-wal` silently and `quick_check` still passes (`PROBES/walprobe/probe.cjs`).
- `VACUUM INTO` on the bundled SQLite 3.53.4 writes a rollback-journal file with no side files; switching the copy to WAL and closing it leaves a WAL header and still no side files, which shipped iOS 1.0.5 can open.
- File sizes of both layouts (`PROBES/vacprobe.cjs`, `PROBES/compactprobe.cjs`).
- The session RPCs and the guard trigger in Postgres 16 (`PROBES/sqltest/`, results in 9.7).
- Code facts cited in this pass: iOS 1.0.5 rebuilds `config` and writes the editor's snapshot (`EntryEditorView.swift:579-712`), shows Edit for every entry type (`EntryDetailView.swift:30-45`), pulls only on a newer mtime (`VaultManager.swift:515`) and stamps its own write's mtime (`:733-737`), drops pending write-backs on close (`:238-247`); desktop watches with `>` (`network-watcher.ts:114,129`), caps uploads at 10 MiB (`cloud-sync.ts:15,678`), honors `CONDUIT_ENV` in packaged builds (`env-config.ts:55-66`), expires the tier cache by subtraction only (`supabase.ts:705-721`), has no Linux fingerprint branch (`fingerprint.ts`), roots data under `appData` (`app-identity.ts:17`), and closes every session on lock (`ipc/vault.ts:133-140`, `state.ts:229-237`).
- Earlier re-reads kept from the synthesis: `vault.ts` unlock, reload, `rekey` and `changePassword`; `database.ts` open and recursive delete; `main.ts` quit and close handlers; `vaultStore.ts:276-281`; `VaultMigrations.swift`; `VaultFileCoordinator.swift` write-back and stage; `IdentityKeyService.swift:73-80`; `AutoLockManager.swift`; GRDB `foreignKeysEnabled`; the website and desktop `user_profiles` writers.
