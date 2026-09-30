# Home dashboard, folder view and entry activity

Status: approved spec, 2026-09-29. Branch `advenimus/dashboard`. This spec supersedes the R3-DASHBOARD line "texts and order unchanged" in `docs/VISUAL_REDESIGN.md` for the Home dashboard, the folder dashboard and the entry dashboard.

Four builders implement it in parallel from the commit that adds this file. Section 10 lists the work packages. No file belongs to two packages. The contract files (section 9.1) are already written and are frozen: a builder who thinks a contract must change stops and asks the lead.

**Evidence tags.** [V] verified by reading the code at this commit. [A] assumed; the package that owns the code confirms it.

---

## 1. Goals and rules

1. **Getting back is one step.** Home is a pinned tab that is always there while a vault is open, with a shortcut and a menu item.
2. **One screen, no clutter.** Home shows seven sections in a fixed order. A section with nothing to show takes no space. The user can hide any section.
3. **Restyle, not redesign.** Reuse the primitives in `src/components/ui` (`Card`, `SectionHeader`, `ListRow`, `Button`, `IconButton`, `Badge`, `SearchInput`, `Select`, `Checkbox`, `Popover`, `Spinner`, `EmptyState`) and the `--c-*` tokens through the existing Tailwind classes. No new colors, radii, shadows or type sizes. The Home page keeps `bg-editor`, `max-w-4xl mx-auto p-6 space-y-6`, and two-column `grid grid-cols-1 @2xl:grid-cols-2 gap-4` rows. The page is an `@container`, so the grid follows the pane width: Home also fills split panes (3.4).
4. **Plain words.** Every string is in section 8. No em dashes in any string.
5. **Local and private.** Connection history stays on this device, outside the vault file, and stores entry ids only.

## 2. Code map at this commit [V]

| Area | File |
|---|---|
| Home, entry and folder dashboards | `src/components/dashboard/DashboardOverview.tsx`, `EntryDashboard.tsx`, `FolderDashboard.tsx`, `VaultStatusCard.tsx`, `relativeTime.ts` |
| Pane body and routing | `src/components/layout/PaneContent.tsx` (routes `dashboard` sessions through `dashboardViewOf`, added by the contract commit) |
| Tabs | `src/components/layout/PaneTabBar.tsx` (close button, drag, context menu, `TabIcon`, `StatusDot`) |
| Sessions and panes | `src/stores/sessionStore.ts`, `src/stores/layoutStore.ts` (a sessionStore subscription adds new sessions to the focused pane) |
| Old Home button | `src/components/layout/Sidebar.tsx` `handleHome` (creates a closable `__home__` session). The harness clicks `[data-sidebar-panel] button[title="Home"]` (`scripts/verify/lib/restyle-data.mjs` `openHome`) |
| Shortcuts | `src/hooks/useKeyboardShortcuts.ts` (Ctrl matches Ctrl or Cmd; skipped in inputs and in `[data-session-keyboard]`) |
| Renderer events and menu actions | `src/App.tsx` (`conduit:close-tab` closes the focused pane's active tab; `menu-action` switch) |
| App menu | `electron/main.ts` `buildAppMenu`. The View menu exists only in dev builds today |
| Vault resets | `vaultStore.lockVault`, `createVault`, `openVault`, `openTeamVault`, `closeTeamVault`, App.tsx `vault-locked-by-system` and `close-all-sessions` all call `sessionStore.clearAll()` then `layoutStore.resetLayout()` |
| Entry info tab | `src/lib/openDashboard.ts` `openDashboardForEntry` (`dashboard::<entryId>`) |
| IPC | `electron/preload.cts` exposes a generic `invoke(channel, args)`; no preload change is needed for new channels. Handlers register in `electron/ipc/index.ts` |
| Renderer and main type mirror | Pattern of `src/types/sync.ts` and `electron/services/sync/app-sync-dto.ts` with a test that compares the MIRROR blocks |
| Password history | `password_history(entry_id, changed_at, ...)` in the vault; `ConduitVault.recordPasswordHistory` stores the old password when it changes; only a per-entry list IPC exists |
| MCP audit log | `mcp/src/audit.ts` appends JSON lines to `~/.config/conduit/audit.log` for every environment; fields `timestamp, tool, client, parameters (redacted by key name), result, duration_ms` |
| Data dir | `electron/services/env-config.ts` `getDataDir()` (separate for dev and prod) |
| Proxies and jump hosts | `src/types/entry.ts` has no proxy or jump host fields for any entry type |

Removed or replaced behavior:

- Selecting an entry or folder in the side bar no longer shows its dashboard in an empty single pane. With a pinned Home tab the first pane is never empty while a vault is open. "View Info" opens entry info and folder views as tabs.
- Home drops the tag chips and the "Recently Modified" list. The search box matches tags.
- `docs/VISUAL_REDESIGN.md` R3-DASHBOARD and the restyle suite's `home-dashboard-full-window` inventory describe the old Home. That inventory will not match after this work; refreshing its fixtures needs a live run of the restyle suite (11.2). Home keeps the "Welcome back" heading, which the restyle suite waits for. The harness's `closeAllSessions` (`scripts/verify/lib/restyle-data.mjs`) closes every tab but Home and treats "only Home left" as done, and the suite clears the connection history before shot 40 so Home shows the same cards on every run.

## 3. Home tab and navigation

### 3.1 The pinned Home tab

- Session id `HOME_SESSION_ID = "__home__"`, type `"dashboard"`, title `"Home"`, status `"connected"`, no `entryId` (`src/lib/dashboardSessions.ts`).
- **Placement.** Created at index 0 of the first pane (`getAllLeaves(root)[0]`). It never moves to another pane. It stays at index 0 of its pane. If the user later splits a new pane before it, Home stays where it is.
- **Cannot be closed.** No close button. `sessionStore.closeSession(HOME)` and `removeSession(HOME)` do nothing. `conduit:close-tab` (Ctrl+W / Cmd+W) does nothing when Home is the active tab. There is no "close others" action in the app today [V]; any future one must skip Home. `clearAll()` still removes it; the guard puts it back (3.3).
- **Cannot be moved.** The Home tab is not draggable. `layoutStore.moveSessionToPane`, `moveSessionToNewSplit` and `splitPane` do nothing for the Home id. `reorderSessionInPane` never moves Home and clamps any other tab's target index to 1 or more in Home's pane. A drop on the Home tab counts as a drop at index 1.
- **Look.** House icon (`HomeIcon`, `text-link`, as today), label "Home", no status dot, no close button, attribute `data-cv-home-tab=""`, tooltip "Home (Cmd+Shift+H)" on macOS and "Home (Ctrl+Shift+H)" elsewhere. Right-click shows no menu.
- Next tab and previous tab (Ctrl+Tab) include Home.

### 3.2 Entry points

All entry points call `openHome()` from `src/lib/openHome.ts`:

1. Shortcut Cmd+Shift+H on macOS, Ctrl+Shift+H on Windows and Linux (`useKeyboardShortcuts`, key `h`, ctrl and shift, dispatches `conduit:home`).
2. App menu View > Home, accelerator `CmdOrCtrl+Shift+H`, sends menu action `home`. The View menu now exists in every build: packaged builds show only "Home"; dev builds show "Home", a separator, then the current dev items unchanged.
3. The side bar footer Home button. Its `label` and `title` stay exactly "Home" (the harness selector depends on the title).

`openHome()`: does nothing when no vault is unlocked; otherwise `ensureHomeTab()`, then `focusSession(HOME_SESSION_ID)`, then `useSidebarStore.getState().autoCollapse()` (a floating side bar closes, a docked one stays).

`handleHome` and the `HOME_ID` constant leave `Sidebar.tsx`.

### 3.3 Recreated after lock and vault switch

`installHomeTabGuard()` (in `openHome.ts`, installed once from `App.tsx`) subscribes to `useVaultStore` and `useSessionStore`. On each change it schedules one check with `queueMicrotask`. The check runs `ensureHomeTab()` when the vault is unlocked and no Home session exists.

The microtask matters: `lockVault` calls `clearAll()` and `resetLayout()` before it sets `isUnlocked: false`. A synchronous check would put Home back into a layout that is about to be reset. By the time the microtask runs, the vault reads as locked and nothing happens.

Cases: unlock, vault switch (`openVault`, `openTeamVault` then unlock), `close-all-sessions` (menu), `vault-locked-by-system` then unlock, and a new vault from `createVault` all end with Home as the first tab of the single pane. `openVault` sets `isUnlocked: false` in the same synchronous step as `clearAll()` and `resetLayout()`, before its first `await`, so the guard never puts Home into the vault it is leaving. The guard skips a missing sessions list (the layout store and the recorder read it as empty) and checks again on the next change.

### 3.4 Empty pane shows Home

`PaneContent`: any pane with no sessions renders `<DashboardOverview />`. This replaces "Drag a tab here or open a new session" and the old single-pane branches. `DashboardOverview` shows the old welcome block when the vault has no entries and no folders (8.1).

## 4. Home content

Sections top to bottom. Each is hidden when the user turns it off in Customize, or when it has nothing to show.

```
+-------------------------------------------------------------------------------+
| [H Home] [web-01 *] [Production]                                          [+] |
+-------------------------------------------------------------------------------+
|                                                                               |
|   Welcome back, Chris                                          [Customize]    |
|   12 entries . 3 credentials . 4 folders                                      |
|                                                                               |
|   [Q Search entries and folders...          ] [Quick Connect Cmd+N] [+ New Entry]
|   +-------------------------------------------------------------------------+ |
|   | > web-01                                                            SSH | |  results only
|   |   web-02                                                            SSH | |  while typing
|   |   Production                                                     Folder | |
|   +-------------------------------------------------------------------------+ |
|                                                                               |
|   +- Recently connected -----------------+ +- Open now ---------------------+ |
|   | [ssh] web-01                  Open   | | [ssh] web-01        * Connected| |
|   | [rdp] DC01              2h ago       | | [>_]  Terminal      * Connected| |
|   | [web] Intranet  Failed  Yesterday    | | [rdp] DC01   * Connecting...   | |
|   +--------------------------------------+ +--------------------------------+ |
|   +- Favorites --------------------------+ +- Needs attention --------------+ |
|   | [ssh] web-01                    K  i | | ! 2 changes to review [Review] | |
|   | [web] Intranet Status            Web | | ! 14 passwords older than      | |
|   |                                      | |   180 days      [Show entries] | |
|   +--------------------------------------+ +--------------------------------+ |
|   +- AI activity ------------------------------------------------------------+ |
|   | Recent tool calls from AI agents on this device                          | |
|   | [ssh] Terminal execute . web-01                                  2m ago  | |
|   | [web] Website screenshot . Intranet                 Failed       9m ago  | |
|   +--------------------------------------------------------------------------+ |
|   +- Vault status -----------------------+ +- Overview ---------------------+ |
|   | * Device sync            Up to date  | | [SSH 4]  [RDP 2]  [VNC 1]      | |
|   | * Local backup         Last: 2h ago  | | [Web 3]  [Command 2]           | |
|   | Plan usage                    12/20  | +--------------------------------+ |
|   +--------------------------------------+                                    |
+-------------------------------------------------------------------------------+
K = Copy password, i = View info (IconButtons shown on row hover or focus over the row's meta, ListRow `trailing` with `trailingOverlay`)
```

Layout: header row, then the quick bar (full width), then one `grid grid-cols-1 items-start @2xl:grid-cols-2 gap-4` holding the cards in order: Recently connected, Open now, Favorites, Needs attention, AI activity (`@2xl:col-span-2`), Vault status, Overview. Two columns start at a pane width of 42rem (container query), not a window width. A hidden card takes no cell; later cards move up. `items-start` keeps each card at its own height, so a short card beside a tall one leaves no empty card area.

When every section is hidden in Customize, the page shows one line under the header: "All sections are hidden. Use Customize to show them." (`text-label text-ink-faint`).

**Active view.** `DashboardOverview` takes `active` (default true). `PaneContent` passes `active={false}` while the Home tab is mounted behind another tab of its pane (inactive tabs stay mounted with `display: none`); an empty pane's Home is always active. Recently connected and AI activity load only for an active view (4.3, 4.7).

### 4.1 Header

- Left: `h1` "Welcome back" or "Welcome back, {first name}" and the counts line (as today).
- Right: the Customize button (4.9). Quick Connect moves from the header into the quick bar.

### 4.2 Quick bar (section id `quick`)

Row: `SearchInput` (flex 1) with placeholder "Search entries and folders...", `Button variant="primary"` "Quick Connect" with `Kbd` "⌘N" on macOS or "Ctrl+N" elsewhere (as today), `Button` with icon `plus` "New Entry". New Entry is disabled in a team vault where the user cannot create, with the reason "View-only access" (same rule as the side bar).

Search:

- Matches, case-insensitive, trimmed: entry name, entry host, entry tags, folder name. Credentials and documents are included.
- Ranking: name starts with the query, then name contains it, then host or tag contains it. Ties sort by name (`localeCompare`). At most `QUICK_SEARCH_LIMIT` (8) results.
- Results show in a `Card` right under the row, in the page flow (they push the sections down), only while the query is not empty. Each result is a `ListRow` with the entry icon (folder icon for folders) and `meta` = the type label ("SSH", "RDP", "VNC", "Web", "Command", "Document", "Credential", "Folder").
- Keyboard: Down and Up move the active result and wrap. The first result is active after each change of the query. Enter opens the active result. Escape clears the query; a second Escape (query already empty) blurs the box. Mouse hover sets the active result; click opens it.
- Opening: a folder calls `openFolderView(id)`; a credential calls `openDashboardForEntry(id)`; anything else calls `useEntryStore.getState().openEntry(id)` (locked entries get the existing locked toast). The query clears after opening.
- Accessibility: the input has `role="combobox"`, `aria-expanded`, `aria-controls` and `aria-activedescendant`; the list has `role="listbox"`; rows have `role="option"` and `selected` on the active one.
- No match: one line "No entries or folders match" (`text-label text-ink-faint`).

### 4.3 Recently connected (`recent`)

- Source: `dashboardApi.historyRecent({ limit: 8 })`, filtered to entries that still exist in `useEntryStore`.
- Row: `ListRow`, entry icon, entry name, `meta` = relative time of `lastStartedAt` (`formatRelativeTime`), preceded by `Badge tone="danger"` "Failed" when `lastOutcome` is `failed`. When `lastOutcome` is `open` the meta reads "Open".
- Row click opens the entry, the same as the quick bar's open rule (this is the Open action).
- `trailing` (`EntryRowActions`, with `trailingOverlay`): `IconButton icon="key" label="Copy password"` and `IconButton icon="infoCircle" label="View info"`. On hover or focus they cover the meta, which fades out, so rows with actions keep the same width and right edge as rows without (Open now). Copy password is not shown for an entry the plan locks (`useTierStore` `lockedEntryIds`); View info stays.
- Copy password: `resolveCredential(entryId)`, then the clipboard. Toasts "Password copied" or "No password available" (same strings as the tab menu), "Couldn't copy the password" on a clipboard error. The main process also refuses `entry_resolve_credential` for a plan-locked entry (`electron/services/tier-lock.ts`, the tier store's oldest-first rule; team vaults, local mode and a missing limit are never locked there).
- Refresh: one shared load (`home/homeFeeds.ts`) for every Home view on screen. It runs when an active Home view sees a new set of session ids (750 ms debounce), after Clear connection history, and after the vault unlocks or another vault opens. A lock drops the rows. Views that mount later show the loaded rows at once.

### 4.4 Open now (`open-now`)

- Source: `useSessionStore` sessions, except Home and sessions of type `dashboard` and `document`.
- Row: entry icon when the session has an entry that exists, else the type icon (`terminal` for ssh and local shell, `desktop` for rdp and vnc, `globe` for web, `playerPlay` for command). Label = session title. `meta` = a 12 px filled dot in the state color (same classes as the tab `StatusDot`) and the status text (8.2).
- Row click calls `focusSession(session.id)`.
- At most 8 rows, then "+{n} more" in `text-meta text-ink-faint`.

### 4.5 Favorites (`favorites`)

Entries with `is_favorite`, in store order; `meta` = type label. A single click uses the open rule of Recently connected (a credential opens its info tab, anything else opens). The row has the same trailing actions over the meta as Recently connected (Copy password, not for plan-locked entries, and View info). Hidden when there are no favorites (the old "Star entries to add them here" line goes away).

### 4.6 Needs attention (`attention`)

Hidden when there are no items. Items are built by a pure function (`buildAttentionItems`) from store state, the password ages and the settings. Order: all `danger` items first, then `warning` items, each group in the order below.

| Kind | When | Tone | Title | Detail | Action |
|---|---|---|---|---|---|
| `sync-review` | `activeStatus(sync.state)?.conflictCount > 0` | warning | "{n} change to review" / "{n} changes to review" | "Another device changed the same thing. Pick which to keep." | "Review": `useSyncStore.getState().openView({ kind: "review", row: null })` |
| `sync-paused` | `sync.state.killSwitch` or status kind `paused` | warning | "Sync is paused" | `statusLabel(status, killSwitch)` from `src/components/sync/sync-copy.ts` | "Open Sync settings": `conduit:settings` with `{ tab: "sync" }` |
| `sync-error` | status kind `error` | danger | "Sync has a problem" | `statusLabel(...)` | "Open Sync settings" |
| `team-sync-error` | `teamSyncState?.status === "error"` | danger | "Team sync has a problem" | `teamSyncState.error` | none |
| `local-backup-failed` | local backup enabled and status `error` | danger | "Local backup failed" | `localBackupState.error` | "Open Backup settings": `conduit:settings` with `{ tab: "backup" }` |
| `local-backup-stale` | enabled, not failed, `lastBackedUpAt` older than `backupStaleDays` | warning | "No local backup in {n} days" | "Last backup {relative time}." | "Open Backup settings" |
| `cloud-backup-failed` | `authMode !== "local"`, cloud backup enabled, status `error` | danger | "Cloud backup failed" | `cloudSyncState.error` | "Open Backup settings" |
| `cloud-backup-stale` | as above, not failed, `lastSyncedAt` older than `backupStaleDays` | warning | "No cloud backup in {n} days" | "Last backup {relative time}." | "Open Backup settings" |
| `password-age` | `passwordAgeDays` not null and one or more existing entries have `setAt` older than it | warning | "{n} password older than {period}" / "{n} passwords older than {period}" | "Change old passwords to keep your accounts safe." | "Show entries" / "Hide entries": toggles a list under the item |
| `connection-limit` | `maxConnections > 0` and connection count >= `maxConnections` | warning | "All {max} connections on your plan are in use" | "Upgrade to add more." | "See plans": `invoke("auth_open_pricing")` |
| `device-limit` | `sync.displaced?.reason === "device_cap"` or `sync.sessionConflict?.cause === "device_cap"` | warning | "Device limit reached" | "Your plan allows {cap} devices at once." (`deviceCap` from the event, else `DEFAULT_DEVICE_CAP`) | "See plans" |
| `trial-ending` | `isTrialing` and 0 <= days <= `TRIAL_WARN_DAYS` (7) | danger when days <= 3, else warning | "Your Pro trial ends today" / "Your Pro trial ends tomorrow" / "Your Pro trial ends in {n} days" | "Upgrade to keep Pro features." | "See plans" |

- A backup that is off, or never ran, is not an item.
- `{period}`: 90 "90 days", 180 "180 days", 365 "1 year".
- Row: `alertTriangle` icon (`text-warning` or `text-danger`), title (`text-label text-ink`), detail (`text-meta text-ink-muted`), `Button size="sm"` with the action label on the right.
- Password list: up to `PASSWORD_AGE_LIST_LIMIT` (10) `ListRow`s, oldest first, entry icon, name, `meta` = "{age} old" (age as "3 months", "1 year", "2 years"; whole months under a year, whole years after). Row click calls `openDashboardForEntry`. More than 10: a last line "And {k} more".
- The `device-limit` signals are dialog events and rarely remain while a vault is unlocked. No other device-limit state exists in the renderer [V: `device_cap` appears only in the displaced and session conflict events of `src/types/sync.ts`].
- Password ages load with `dashboardApi.passwordAges()` on mount and 1 s after the entries array changes (debounced). They do not load when `passwordAgeDays` is null or the section is hidden.

### 4.7 AI activity (`ai-activity`)

- Source: `dashboardApi.aiActivity({ limit: 5 })`. Hidden when `logFound` is false or there are no items.
- `SectionHeader` title "AI activity", description "Recent tool calls from AI agents on this device".
- Row: `ListRow` led by the entry's type icon (in the entry's color) when `entryId` names an entry that exists, else `sparkles`; label = tool label, plus " · {target}" when a target is known. Target = the entry name for `entryId`, else the session title for `sessionId`. `meta` = a badge for non-success outcomes (8.2) and the relative time.
- Tool label: underscores become spaces and the first letter is upper case ("terminal_execute" becomes "Terminal execute").
- Row click: `openDashboardForEntry(entryId)` when the entry exists; otherwise the row is not a button.
- Refresh: one shared poller (`home/homeFeeds.ts`) for every Home view. It loads when the first active Home view appears, then every `AI_ACTIVITY_POLL_MS` (30 s) and when the window becomes visible again, only while `document.visibilityState === "visible"`, and stops when no Home view is active. A second active view reuses the same data; a load in flight is shared.

### 4.8 Vault status (`vault-status`)

- **Vault status** (`VaultStatusCard`, title "Vault status"): each status row is a `ListRow` with a 12 px filled dot as `leading` (the Open now colors: connected, error, connecting; faint for off and idle) and the detail as `meta` (`text-meta text-ink-faint`, truncated at 12rem with the full text as its tooltip). Labels in sentence case: "Device sync", "Cloud backup", "Local backup", "Team sync", "Plan usage" (with its bar under the row), "Trial".
- **Overview** (`OverviewCard`): the shared type tiles (`TypeTiles`, order SSH, RDP, VNC, Web, Command, `grid-cols-3`) for the connection types that have entries; zero tiles are not drawn. No counts line (the header already has the counts). The card hides when no connection type has entries.
- Both cards hide together with this one switch ("Vault status and overview").

### 4.9 Customize

- Trigger: `Button variant="ghost" size="sm" icon="settings"` "Customize", right of the heading.
- Opens a `Popover` (placement below, right-aligned) holding:
  - Title "Customize Home" (`text-label font-semibold text-ink`).
  - Group label "Show on Home", then one `Checkbox` per section with the labels in `HOME_SECTION_LABELS` (the last one reads "Vault status and overview").
  - Group label "Needs attention", then `FormField` "Warn about passwords older than" with a `Select`: "90 days", "180 days", "1 year", "Never"; `FormField` "Warn about backups older than" with a `Select`: "3 days", "7 days", "14 days", "30 days".
  - A divider, then `Button variant="link" size="sm"` "Clear connection history..." which opens `ConfirmDialog` (title "Clear connection history?", message "This removes the list of past connections for this vault on this device. Your entries do not change.", confirm "Clear history", variant `danger`). On success: `toast.success("Connection history cleared")`; on failure `toast.error("Couldn't clear the connection history")`.
- Changes save at once with `ui_state_set({ key: "home-dashboard", value })`. Reading uses `ui_state_get`; a missing or malformed value falls back to `DEFAULT_HOME_SETTINGS` field by field (unknown section ids are dropped, numbers outside the option lists fall back to the default). Stored per device in `{dataDir}/ui-state.json` [V].

### 4.10 Loading and errors

Background loads (history, password ages, AI activity) never toast. On failure the section hides and the code logs `console.warn` with the channel name. A section shows no spinner while its first load runs; it appears when data arrives. The saved Home settings load once at app start (`preloadHomeSettings` from `App.tsx`), so the first Home paint already knows which sections are hidden, and later Home views reuse the shared feeds instead of loading again.

## 5. Folder view

Opened by "View Info" on a folder in the side bar (new menu item) and by choosing a folder in the Home search. Tab: id `folder::<folderId>`, type `dashboard`, title = folder name, `metadata.folderId`, folder icon in the folder's color (`getEntryIcon("folder", false, folder.icon)` and `getEntryColor("folder", folder.color)`). One tab per folder; opening again focuses it (`openFolderView`, contract).

```
+-------------------------------------------------------------------------------+
|  [F] Production                                [Check all] [Open all]  [+]    |
|      9 entries . 2 sub-folders                                                |
+-------------------------------------------------------------------------------+
|  [SSH 4] [RDP 2] [Web 2] [Credentials 1]                                      |
|                                                                               |
|  [Q Search this folder...            ]                Sort by [Name        v] |
|                                                                               |
|  [ssh] web-01                                    [Up 24 ms]  5m ago  P > i    |
|        web01.example.com                                                      |
|  [ssh] web-02                                    [Port closed]               |
|        web02.example.com . in Web                                             |
|  [rdp] DC01                                      [No answer]  2d ago          |
|        10.0.0.10                                                              |
|  [key] Domain Admin                                                           |
|        in Accounts                                                            |
+-------------------------------------------------------------------------------+
P = Check if it is up, > = Open, i = View info (ListRow trailing, shown on hover or focus)
```

- **Width**: the page content (header row, tiles, toolbar, list) sits in `mx-auto w-full max-w-4xl`, Home's width; the header's `border-b` still spans the pane.
- **Header** (as today: `p-6 border-b border-divider`, folder icon 28, name, counts line). Right side: `Button` "Check all", `Button variant="primary"` "Open all", `IconButton icon="plus" label="New Entry"` (dispatches `conduit:new-entry` with `{ folderId }`).
- **Type tiles**: the same `TypeTiles` markup as Home's Overview, in the shared order SSH, RDP, VNC, Web, Command, Document, Credential, one tile per type present, labelled with the type labels of 4.2. The type distribution bar, "Recent Activity" and "Entry Age" blocks are removed; the list below covers them.
- **Toolbar**: `SearchInput` placeholder "Search this folder..." (max width `max-w-sm`), and on the right the label "Sort by" with a `Select`: "Name" (A to Z), "Type" (type label, then name), "Last connected" (newest first, never last), "Status" (reachable, refused, timeout, unreachable, not found, not checked; then name).
- **List**: every entry in the folder and all its sub-folders (the recursive rule of today's `FolderDashboard`), filtered by the search (name, host, tags; case-insensitive), in the chosen order.
- **Row**: `ListRow`, entry icon, name. `description`: the host for connection types, plus " · in {sub-folder path}" for entries below a sub-folder (path joined with " / ", relative to the viewed folder). `meta`: the reachability badge when checked (8.3), then the relative time of the last connection from `dashboardApi.historyRecent({ limit: 50 })` when known. `trailing`: `IconButton icon="plug" label="Check if it is up"` (connection types with a host only; disabled while that row checks), `IconButton icon="playerPlay" label="Open"` (not for credentials), `IconButton icon="infoCircle" label="View info"`.
- **Row click**: a credential opens its info tab; anything else opens (`openEntry`).
- **Open all**: opens the listed (filtered) entries of type ssh, rdp, vnc and web that are not locked. Commands, documents and credentials are skipped. It stops before the next entry once the folder view unmounts or the vault locks. More than `OPEN_ALL_CONFIRM_THRESHOLD` (5): `ConfirmDialog` title "Open {n} connections?", message "This opens {n} sessions at once. Commands and documents are not opened.", confirm "Open {n}", cancel "Cancel". Entries open one after another (`await openEntry(id)` each). Disabled with title "Nothing to open here" when the count is 0.
- **Check all**: checks the listed entries that can be checked (ssh, rdp, vnc, web with a host), in list order, at most `CHECK_ALL_LIMIT` (50), four at a time. While it runs the button reads "Checking {done} of {total}..." and is disabled. When the list had more than 50: `toast.info("Checked the first 50 entries", "Search or sort the list to check others.")`.
- **Empty folder**: as today ("This folder is empty" and New Entry). **No match**: "No entries match your search" (`text-label text-ink-faint`, centered).
- Results of checks are shared by every folder view and entry info tab (one store in `reachability/useReachability.ts`), so a split or a remounted tab keeps them. They are dropped when the vault locks and are never saved. A result is hidden once the entry's type, host or port differs from the one that was checked.
- The tab of a folder view or an entry info tab has no status dot; it is a page, not a connection.

## 6. Entry info additions (EntryDashboard)

```
+-------------------------------------------------------------------------------+
|  [ssh] web-01                                   * pen ext     [Open Session]  |
|        SSH                                                                    |
+-------------------------------------------------------------------------------+
|  Host         web01.example.com:22                                     [copy] |
|  Is it up?    [Up] Answered in 24 ms . checked just now        [Check again]  |
|               Direct check from this device to port 22. Proxies are not used. |
|  Username     deploy                                                   [copy] |
|  ...                                                                          |
|  Modified     Sep 20, 2026 (1w ago)                                           |
|                                                                               |
|  Recent connections                                                           |
|  Connections from this device only.                                           |
|  (v) Connected                                   Sep 29, 2:14 PM . 1 h 5 min  |
|  (x) Could not connect                           Sep 28, 9:02 AM              |
|  (!) Disconnected with an error                  Sep 27, 4:40 PM . 12 min     |
+-------------------------------------------------------------------------------+
```

The header's second line is the type label of 4.2 ("SSH", "RDP", "VNC", "Web", "Command", "Document", "Credential"), not the raw type.

### 6.1 "Is it up?"

- A `DetailRow` right after Host, for ssh, rdp, vnc and web entries that have a host. Icon `plug`.
- Value before a check: "Not checked yet". While checking: `Spinner` and "Checking...". After: the badge (8.3), the detail text, and " · checked {relative time}".
- Under the value, always: "Direct check from this device to port {port}. Proxies are not used." The port is the entry port or the default (22, 3389, 5900; for web the URL port, else 443 for https and 80 for http). Use the port from the last result when there is one.
- Action: `Button size="sm"` "Check" before the first check and "Check again" after; disabled while checking.

### 6.2 Recent connections

- For ssh, rdp, vnc, web and command entries. Below the details column (left column when notes exist).
- `SectionHeader` title "Recent connections", description "Connections from this device only."
- Source: `dashboardApi.historyForEntry({ entryId, limit: 20 })`, loaded on mount and 750 ms after the session ids change.
- The list sits at `-mx-2`, so the rows' own padding lines their icons up with the detail rows above.
- Row: `ListRow` without `onClick`. Leading icon and label by outcome (8.2). `meta`: date and time (`toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })`), plus " · {duration}" when `durationMs` is known and the outcome is not `failed` (a failed row's time is the connection attempt). Duration: under 60 s "{s} s", under 60 min "{m} min", else "{h} h {m} min".
- Empty: "No connections from this device yet." (`text-label text-ink-faint`).
- Load error: the section shows the empty line and logs `console.warn`.

## 7. Data design

### 7.1 Connection history store (main process)

- **File**: `{getDataDir()}/connection-history.db`, SQLite through `better-sqlite3` (already a dependency; loads under vitest [V]). Outside the vault file, so it is not synced, not in cloud backups and not in vault exports. The owner confirms that local backups copy only vault files [A].
- **Schema** (`PRAGMA user_version = 1`):

```sql
CREATE TABLE IF NOT EXISTS connection_history (
  id          TEXT PRIMARY KEY,
  vault_key   TEXT NOT NULL,
  entry_id    TEXT NOT NULL,
  protocol    TEXT NOT NULL CHECK (protocol IN ('ssh','rdp','vnc','web','command')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  duration_ms INTEGER,
  outcome     TEXT NOT NULL CHECK (outcome IN ('open','closed','dropped','failed','interrupted'))
);
CREATE INDEX IF NOT EXISTS idx_history_vault_started ON connection_history (vault_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_vault_entry ON connection_history (vault_key, entry_id, started_at DESC);
```

- **Vault key** (computed in the main process at `start`, never sent by the renderer): a team vault is `team:<teamVaultId>`; a personal vault is `vault:<vault_meta.vault_id>` when that value exists, read without creating it (`ConduitVault.getVaultId()` creates and syncs it, so do not call it), else `path:<first 32 hex chars of sha256(path.resolve(vault path))>`. A vault without `vault_id` that later gets one starts a new history; that is accepted.
- **Privacy**: rows hold the vault key, entry id, protocol, times, duration and outcome. No host names, entry names, user names, error text or credentials. Deleting an entry leaves its rows; the renderer drops rows whose entry is gone, and retention removes them later.
- **Retention**: rows with `started_at` older than `HISTORY_RETENTION_DAYS` (90) are deleted, then each vault key keeps its newest `HISTORY_MAX_ROWS_PER_VAULT` (5000). Pruning runs when the store opens and after every 50th insert.
- **Crash, reload and quit**: when the store opens (first use in a process) every `open` row becomes `interrupted` (ended_at and duration stay null). A renderer that starts (app start or a reload) calls `connection_history_interrupt_open` before its first start, since it cannot end rows an earlier renderer opened; all rows in the file belong to this device. On `app.on('will-quit')` every `open` row gets `ended_at = now`, its duration and `closed`.
- **File safety**: on macOS and Linux the file is created `0600` before SQLite opens it, and the file, `-wal` and `-shm` are set to `0600` after open (SQLite gives new WAL files the database file's mode). The crash cleanup and pruning run inside the guarded open, which closes the handle on any failure. A file that fails with `SQLITE_CORRUPT*` or `SQLITE_NOTADB` is renamed with its `-wal` and `-shm` to `connection-history.db.damaged-<ms>` and a new file is created once; history is only a convenience.
- **Times** come from the main process clock, ISO 8601.

### 7.2 Recording rules (renderer recorder)

`installConnectionHistoryRecorder()` in `src/lib/connectionHistoryRecorder.ts` (installed from `src/main.tsx` by the contract commit) first calls `connection_history_interrupt_open` (7.1; starts wait for it, and a failure only logs), then subscribes to `useSessionStore` and compares each state with the previous one. A missing sessions list counts as empty, the rule of the layout store. Recording in the renderer covers every protocol with one hook and knows the entry id, which the main process does not have for SSH (`ssh_session_create` gets only host and port [V]). Sessions opened by MCP tools arrive without an entry id (`session:mcp-created` [V]) and are not recorded; they show in AI activity.

A session is **recordable** when it has an `entryId` and its type is ssh, rdp, vnc, web or command. The recorder keeps, per session id: entry id, protocol, the promise of the history row id, and `reachedConnected`.

On each change, for the recordable sessions:

1. **Id swap.** A tracked id that disappeared and a new untracked recordable id with the same entry id and protocol in the same change are one session (`replaceSessionId`, used by SSH and web). Move the tracking to the new id. No IPC.
2. **Start.** A recordable session in `connecting` or `connected` that is not tracked: call `historyStart({ entryId, protocol })` and track it. A `null` answer means no vault is open; keep tracking so the end is skipped.
3. **Connected.** A tracked session in `connected` sets `reachedConnected`.
4. **Reconnect.** A tracked session that goes from `connected` to `connecting`: end the row with `closed`, then start a new row (`reachedConnected` false).
5. **Disconnected.** A tracked session that goes to `disconnected`: end with `failed` when it never connected, else `dropped` when it has an error, else `closed`. Stop tracking it. A later reconnect starts a new row by rule 2.
6. **Removed.** A tracked id that is gone and was not swapped: end with `closed`. Stop tracking.

End calls wait for the start promise and skip a null id. IPC errors log `console.warn` and never toast. A vault lock clears the sessions, which ends their rows (the end call does not need an unlocked vault).

### 7.3 Password ages

`ConduitVault.listPasswordAges()` reads, without decrypting anything:

```sql
SELECT e.id AS entry_id, e.created_at, MAX(h.changed_at) AS last_changed
FROM entries e LEFT JOIN password_history h ON h.entry_id = e.id
WHERE e.password_encrypted IS NOT NULL
GROUP BY e.id
```

`setAt` = `last_changed` (source `history`) or `created_at` (source `created`). A history row stores the old password at the moment it changed, so its `changed_at` is when the current password was set [V: `recordPasswordHistory`]. History rows cover the username and the password together, so an edit that changes only the username also writes a row and resets the age. This is accepted: the vault schema is shared with other devices and the iOS app and does not change for this, and the Needs attention wording ("passwords older than") stays. The DATA package confirms that every path that changes a password records history (entry edit, MCP credential tools, imports) and lists any that do not [A]. Entries that use a linked credential have no password of their own and are not listed; their credential entry is. Returns `[]` when no vault is unlocked.

### 7.4 AI activity

- **Log**: `path.join(os.homedir(), '.config', 'conduit', 'audit.log')`, the same path as `mcp/src/audit.ts` `defaultAuditLogPath` [V].
- **New field**: `mcp/src/audit.ts` adds `env` to every new line: `'preview'` when `process.env.CONDUIT_ENV === 'preview'`, else `'production'` (the rule of `mcp/src/ipc-client.ts` [V]). Existing fields and redaction do not change, so the MCP live suite still reads its three lines.
- **Read**: stat the file; missing gives `{ items: [], logFound: false }`. Read at most `AI_ACTIVITY_TAIL_BYTES` (512 KiB) from the end; when the read starts after byte 0, drop the first partial line. Parse each line in `try`; skip lines that are not objects with a string `timestamp`, a `tool` matching `^[a-z0-9_]{1,64}$` and a `result.type` in the outcome list.
- **Environment filter**: keep lines whose `env` equals `getEnvConfig().environment`. Lines without `env` (written before this change) are kept only when the app runs as `production`.
- **Fields out**: `at`, `tool`, `outcome`, `durationMs` (`duration_ms`, 0 when missing), `entryId` from `parameters.entry_id` (or `parameters.id` for tools whose name starts with `entry_`, `credential_` or `document_`), `sessionId` from `parameters.session_id`. An id is kept only when it matches `^[A-Za-z0-9_-]{1,64}$`. No other parameter and no error text leaves the main process.
- Newest first, `limit` clamped to 1..`AI_ACTIVITY_MAX`. A read error logs a warning and returns `{ items: [], logFound: false }`. No file watching; the renderer polls.
- While no vault is active (locked, or soft-locked because another device took it over), the channel answers `{ items: [], logFound: false }` without reading the log.

### 7.5 Reachability check

- Main process only, `node:net` `connect`. Input is an entry id; the main process reads the entry from the active vault. Locked vault: the call rejects with "Vault is locked".
- **Target**: ssh uses `port ?? 22`, rdp `port ?? 3389`, vnc `port ?? 5900`. web parses the host field as a URL (adds `https://` when there is no scheme); hostname from the URL (square brackets removed for IPv6), port from the URL or 443 for `https:` and 80 for `http:`; other schemes are `invalid`. command, document and credential are `not_checkable`.
- **Validation**: host trimmed, 1 to 253 characters, and either `net.isIP(host) !== 0` or a DNS name (labels of letters, digits, `-` and `_`, 1 to 63 characters, not starting or ending with `-`). Port an integer 1..65535. Otherwise `invalid`. No host at all is `invalid`.
- **Check**: one timer of `REACHABILITY_TIMEOUT_MS` (3 s) covers name lookup and connect. `connect` event: `reachable` with `latencyMs`, then destroy the socket. Errors: `ECONNREFUSED` refused; `ENOTFOUND`, `EAI_AGAIN`, `EAI_NONAME` not_found; `ETIMEDOUT` timeout; `EHOSTUNREACH`, `ENETUNREACH`, `EHOSTDOWN`, `ENETDOWN` and anything else unreachable. The timer firing is `timeout`. Always destroy the socket and clear the timer.
- **Limits**: at most `REACHABILITY_MAX_CONCURRENT` (4) checks at once, the rest wait in order. A slot is held until the check's result is in and its name lookup has returned: the socket uses the system resolver (`dns.lookup`, so `.local` names and `/etc/hosts` keep working) through a wrapped `lookup` option, and a timed-out socket cannot cancel `getaddrinfo`, so a stalled resolver never piles up more than four lookups. A check of the same entry, type, host and port within `REACHABILITY_MIN_INTERVAL_MS` (2 s) of its last result returns that result; one already in flight shares its promise. An edited host, port or type is a new check.
- **Direct only**: entries have no proxy or jump host settings [V], so there is nothing to follow. The check uses the operating system's name lookup and does not use the app's proxy settings. The UI says so (6.1). Logs never print host names above debug level.

## 8. UI strings

Every user-visible string of this feature. Strings not listed here stay as they are today.

### 8.1 Home

| Where | String |
|---|---|
| Tab label | Home |
| Tab tooltip | Home (Cmd+Shift+H) on macOS, Home (Ctrl+Shift+H) elsewhere |
| Side bar button label and title | Home |
| App menu | View > Home |
| Heading | Welcome back / Welcome back, {first name} |
| Counts | {n} entry / {n} entries · {n} credential / {n} credentials · {n} folder / {n} folders |
| Customize button | Customize |
| Search placeholder | Search entries and folders... |
| Quick Connect | Quick Connect (Kbd ⌘N or Ctrl+N) |
| New Entry | New Entry; disabled reason: View-only access |
| No search match | No entries or folders match |
| Result type labels | SSH, RDP, VNC, Web, Command, Document, Credential, Folder |
| Card titles | Recently connected, Open now, Favorites, Needs attention, AI activity, Vault status, Overview |
| All sections hidden | All sections are hidden. Use Customize to show them. |
| Recently connected meta | Open, {relative time}; badge Failed |
| Row actions (Recently connected, Favorites) | Copy password, View info |
| Vault status rows | Device sync, Cloud backup, Local backup, Team sync, Plan usage, Trial |
| Toasts | Password copied / No password available / Couldn't copy the password |
| Open now overflow | +{n} more |
| AI activity description | Recent tool calls from AI agents on this device |
| Empty vault (unchanged) | Welcome to Conduit / Get started by creating your first entry or connecting to a remote host. / New Entry / Quick Connect |
| Overview tiles | SSH, RDP, VNC, Web, Command |
| Customize title | Customize Home |
| Customize groups | Show on Home / Needs attention |
| Section labels | Search and quick actions, Recently connected, Open now, Favorites, Needs attention, AI activity, Vault status and overview |
| Threshold fields | Warn about passwords older than: 90 days, 180 days, 1 year, Never / Warn about backups older than: 3 days, 7 days, 14 days, 30 days |
| Clear history | Clear connection history... / Clear connection history? / This removes the list of past connections for this vault on this device. Your entries do not change. / Clear history / Cancel |
| Clear toasts | Connection history cleared / Couldn't clear the connection history |
| Needs attention | The titles, details and action labels in the table of 4.6, plus "Hide entries" (after Show entries), "{age} old", "And {k} more" |

### 8.2 Status words

| Where | Value | String |
|---|---|---|
| Open now | connected | Connected |
| Open now | connecting | Connecting... |
| Open now | connecting with `metadata.reconnecting` | Reconnecting... |
| Open now | disconnected | Disconnected |
| History outcome (entry info), icon | open, `circleFilled` in `text-(--c-state-connected)` | Connected now |
| | closed, `circleCheck` in `text-(--c-state-connected)` | Connected |
| | dropped, `alertTriangle` in `text-warning` | Disconnected with an error |
| | failed, `circleX` in `text-danger` | Could not connect |
| | interrupted, `clock` in `text-ink-faint` | Ended when Conduit closed |
| AI activity badge | error (`danger`) | Failed |
| | rate_limited (`warning`) | Rate limited |
| | access_denied (`danger`) | Denied |

### 8.3 Reachability

| Status | Badge (tone) | Detail |
|---|---|---|
| reachable | Up (success) | Answered in {ms} ms (rounded); Answered in under 1 ms when the latency is under 1 ms or unknown |
| refused | Port closed (warning) | Nothing is listening on port {port} |
| timeout | No answer (warning) | No answer in 3 seconds |
| unreachable | Down (danger) | No route to this host |
| not_found | Unknown host (danger) | Could not find this host name |
| invalid | Cannot check (neutral) | The host or port of this entry is not valid |
| not_checkable | Cannot check (neutral) | This entry has no host and port to check |
| (while running) | Spinner | Checking... |
| (never checked) | none | Not checked yet |
| Hint | | Direct check from this device to port {port}. Proxies are not used. |
| Buttons | | Check, Check again, Check if it is up (row icon) |

### 8.4 Folder view

| Where | String |
|---|---|
| Side bar folder menu | View Info |
| Counts line | {n} entry / {n} entries · {m} sub-folder / {m} sub-folders (as today) |
| Buttons | Check all, Checking {done} of {total}..., Open all, New Entry |
| Open all disabled title | Nothing to open here |
| Search placeholder | Search this folder... |
| Sort | Sort by: Name, Type, Last connected, Status |
| Row description | {host} · in {Sub / Path} |
| Row actions | Check if it is up, Open, View info |
| Open all confirm | Open {n} connections? / This opens {n} sessions at once. Commands and documents are not opened. / Open {n} / Cancel |
| Check all cap toast | Checked the first 50 entries / Search or sort the list to check others. |
| No match | No entries match your search |
| Empty folder (unchanged) | This folder is empty / New Entry |

### 8.5 Entry info

| Where | String |
|---|---|
| Header type line | SSH, RDP, VNC, Web, Command, Document, Credential |
| Row label | Is it up? |
| Section | Recent connections / Connections from this device only. |
| Empty | No connections from this device yet. |
| Durations | {s} s, {m} min, {h} h {m} min |

## 9. Contracts

### 9.1 Files written by the contract commit (frozen)

| File | What |
|---|---|
| `src/types/dashboard.ts` | Every payload type, channel name, limit and Home setting (MIRROR block plus renderer-only part) |
| `electron/services/dashboard/dashboard-dto.ts` | Main process copy of the MIRROR block |
| `electron/services/dashboard/__tests__/dashboard-dto-mirror.test.ts` | Fails when the two MIRROR blocks differ |
| `src/lib/dashboardApi.ts` | Typed `invoke` wrappers for every channel |
| `src/lib/dashboardSessions.ts` | `HOME_SESSION_ID`, `HOME_TITLE`, `entryInfoSessionId`, `folderViewSessionId`, `isHomeSession`, `dashboardViewOf` |
| `src/lib/focusSession.ts` | `focusSession(sessionId): boolean` |
| `src/lib/openDashboard.ts` | `openDashboardForEntry` (now focuses through `focusSession`) and `openFolderView` |
| `src/lib/connectionHistoryRecorder.ts` | Stub `installConnectionHistoryRecorder()`; DATA implements it |
| `src/main.tsx` | Calls `installConnectionHistoryRecorder()` once at startup |
| `src/components/layout/PaneContent.tsx` | `dashboard` sessions route through `dashboardViewOf` to Home, entry info or folder view |
| `src/lib/__tests__/dashboardSessions.test.ts` | Tests of the above |

### 9.2 IPC channels

All handlers live in `electron/ipc/dashboard.ts` (`registerDashboardHandlers`, called from `electron/ipc/index.ts`). Arguments are one object with camelCase keys. Invalid arguments reject with `Error("Invalid request")`. Channel names come from `DASHBOARD_CHANNELS`.

| Channel | Request | Response | Notes |
|---|---|---|---|
| `connection_history_start` | `HistoryStartRequest { entryId, protocol }` | `{ id } \| null` | null when no vault is unlocked. `entryId` 1..128 chars |
| `connection_history_end` | `HistoryEndRequest { id, outcome }` | `void` | Only rows still `open` change; unknown ids do nothing; works while locked |
| `connection_history_recent` | `HistoryRecentRequest { limit? }` | `RecentConnection[]` | Active vault only; one row per entry, newest first; limit default 8, clamp 1..50; `[]` when locked |
| `connection_history_for_entry` | `HistoryForEntryRequest { entryId, limit? }` | `ConnectionHistoryEvent[]` | Active vault only; newest first; default 20, clamp 1..100; `[]` when locked |
| `connection_history_clear` | `{}` | `HistoryClearResponse { deleted }` | Active vault only; `{ deleted: 0 }` when locked |
| `connection_history_interrupt_open` | `{}` | `HistoryInterruptResponse { interrupted }` | Every `open` row becomes `interrupted`; works while locked. Called once by each new recorder (7.2) |
| `password_age_list` | `{}` | `PasswordAgeItem[]` | `[]` when locked |
| `ai_activity_recent` | `AiActivityRequest { limit? }` | `AiActivityResponse { items, logFound }` | Default 20, clamp 1..100; `{ items: [], logFound: false }` while no vault is active |
| `reachability_check` | `ReachabilityRequest { entryId }` | `ReachabilityResult` | Rejects "Vault is locked" and "Entry not found" |

### 9.3 Renderer events and menu actions

| Name | Kind | Sender | Handler |
|---|---|---|---|
| `conduit:home` | document CustomEvent | `useKeyboardShortcuts` | `App.tsx` calls `openHome()` |
| `home` | `menu-action` payload | `electron/main.ts` View > Home | `App.tsx` calls `openHome()` |
| `conduit:settings` `{ tab: "sync" \| "backup" }` | existing | Needs attention actions | existing |

### 9.4 Module APIs owned by packages

| Module | Owner | API |
|---|---|---|
| `src/lib/openHome.ts` | NAV | `ensureHomeTab(): void`, `openHome(): void`, `installHomeTabGuard(): () => void` |
| `src/lib/connectionHistoryRecorder.ts` | DATA | `installConnectionHistoryRecorder(): () => void` |
| `src/components/dashboard/home/attention.ts` | HOME | `buildAttentionItems(input: AttentionInput): AttentionItem[]` (pure) |
| `src/components/dashboard/home/quickSearch.ts` | HOME | `searchQuick(query, entries, folders, limit): QuickResult[]` (pure) |
| `src/components/dashboard/home/useHomeSettings.ts` | HOME | `useHomeSettings(): { settings, update(patch) }`, `parseHomeSettings(raw): HomeSettings` |
| `src/components/dashboard/reachability/reachabilityCopy.ts` | PANELS | `reachabilityText(result): { badge, tone, detail }` |
| `src/components/dashboard/reachability/useReachability.ts` | PANELS | `useReachability(): { results, checking, check(entryId), checkMany(ids) }` |

## 10. Work packages

Each package works in its own worktree branched from the contract commit, commits with conventional commit messages and no AI attribution, and does not push. A file not listed under a package's "Owns" is read-only for it. The frozen contract files (9.1) are read-only for everyone except where a package below is named as their owner, and even then their exported API does not change. `docs/DASHBOARD.md`, `docs/FEATURES.md` and `docs/VISUAL_REDESIGN.md` belong to the lead. `src/components/dashboard/__tests__/fixtures.ts` is read-only for everyone; put new test helpers in package-owned files.

### Testing policy (all packages)

1. Unit tests for every file you touch, with `npx vitest run <paths>`; then the whole `npx vitest run` passes (and `cd mcp && npx vitest run` for DATA).
2. `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors.
3. `npm run lint` reports no errors (4 warnings at the contract commit).
4. `npm run build` passes.
5. Open the app once with a small one-off script that uses `scripts/verify/lib` (pattern: `scripts/verify/capture-spacing.mjs` and `scripts/verify/lib/spacing-screens.mjs`), click through the changed screens and save screenshots under `.verify/dashboard/<package>/`. Name the script `scripts/verify/capture-dashboard-<package>.mjs` (package-owned).
6. Do not run any live `/verify` suite and do not run `npm run verify`.

### 10.1 NAV: pinned Home tab and navigation

**Spec:** `docs/DASHBOARD.md` sections 3, 8.1, 9.3 and 9.4. Base: the contract commit on `advenimus/dashboard`.

**Owns (only these files):**
- `src/lib/openHome.ts` (new)
- `src/lib/focusSession.ts`, `src/lib/dashboardSessions.ts` (contract files: keep their exports as they are; you may add helpers)
- `src/stores/sessionStore.ts`, `src/stores/layoutStore.ts`
- `src/components/layout/PaneTabBar.tsx`, `src/components/layout/PaneContent.tsx`, `src/components/layout/Sidebar.tsx`
- `src/hooks/useKeyboardShortcuts.ts`
- `src/App.tsx`
- `electron/main.ts`
- Tests: `src/lib/__tests__/openHome.test.ts` (new), `src/stores/__tests__/sessionStore.test.ts` (new), `src/stores/__tests__/layoutStore.test.ts` (new), `src/hooks/__tests__/useKeyboardShortcuts.test.ts` (new), `src/components/layout/__tests__/panes.test.tsx`, `PaneTabBar.test.tsx`, `Sidebar.test.tsx`
- `scripts/verify/capture-dashboard-nav.mjs` (new, one-off)

**Build:**
1. `src/lib/openHome.ts`:
   - `ensureHomeTab()`: does nothing unless `useVaultStore.getState().isUnlocked`. When no session has `HOME_SESSION_ID`: focus the first leaf (`getAllLeaves(root)[0]`), `addSession({ id: HOME_SESSION_ID, type: "dashboard", title: HOME_TITLE, status: "connected" })`, then `reorderSessionInPane` it to index 0 of that pane.
   - `openHome()`: does nothing while locked; else `ensureHomeTab()`, `focusSession(HOME_SESSION_ID)`, `useSidebarStore.getState().autoCollapse()`.
   - `installHomeTabGuard()`: subscribes to `useVaultStore` and `useSessionStore`; each change schedules one `queueMicrotask` check that calls `ensureHomeTab()` when unlocked and Home is missing. Returns an unsubscribe. The microtask is required (spec 3.3: `lockVault` clears sessions before it sets `isUnlocked: false`).
2. `sessionStore`: `closeSession(HOME)` and `removeSession(HOME)` do nothing; `replaceSessionId(HOME, ...)` does nothing. `clearAll()` is unchanged.
3. `layoutStore`: `moveSessionToPane`, `moveSessionToNewSplit` and `splitPane` with the Home id do nothing. `reorderSessionInPane` never moves Home and, in Home's pane, clamps the target index of other tabs to 1 or more. `removeSessionFromPane(HOME)` still works (used after `clearAll`).
4. `PaneTabBar`: the Home tab is not draggable, has no close button, no `StatusDot` and no context menu (right-click is prevented), carries `data-cv-home-tab=""` and the tooltip "Home (Cmd+Shift+H)" on macOS, "Home (Ctrl+Shift+H)" elsewhere. A drop at index 0 of Home's pane lands at index 1. `TabIcon` shows the folder icon in the folder's color for folder view tabs (`dashboardViewOf(session).kind === "folder"`).
5. `PaneContent`: any pane with no sessions renders `<DashboardOverview />`. Remove the "Drag a tab here or open a new session" text, the `selectedEntryId` branch and the welcome block (HOME moves that block into `DashboardOverview`). Keep the `dashboard` routing the contract added.
6. `Sidebar`: delete `handleHome` and `HOME_ID`; the footer Home `IconButton` calls `openHome`. Its `label` and `title` stay exactly "Home" (the harness clicks `button[title="Home"]`).
7. `useKeyboardShortcuts`: add `{ key: "h", ctrl: true, shift: true, description: "Go to Home" }` dispatching `conduit:home`.
8. `App.tsx`: listen for `conduit:home` and call `openHome()`; handle menu action `home` with `openHome()`; `handleCloseTab` does nothing when the active tab is Home; install the guard once with `useEffect(() => installHomeTabGuard(), [])`.
9. `electron/main.ts`: the View menu exists in every build. First item "Home", accelerator `CmdOrCtrl+Shift+H`, `click: () => sendMenuAction('home')`. Dev builds then show a separator and the current dev items unchanged; packaged builds show only "Home".

**Do not edit:** anything in `src/components/dashboard/`, `src/stores/vaultStore.ts`, `src/components/entries/EntryTree.tsx`, `src/lib/openDashboard.ts`.

**Acceptance:**
- Unit tests of spec 11.1 NAV pass; whole `npx vitest run` passes.
- Both `tsc` runs clean, `npm run lint` no errors, `npm run build` passes.
- One app run with `scripts/verify/capture-dashboard-nav.mjs` (screens under `.verify/dashboard/nav/`): Home is the first tab with no close button after unlock; open two sessions, press Cmd+Shift+H (or Ctrl+Shift+H) and Home is active; Ctrl+W on Home does nothing; lock and unlock and Home is back as the only tab; View > Home works (drive it with `mainEval` clicking the menu item, or send the `menu-action`); an empty second pane (make one with `useLayoutStore.getState().splitPane(paneId, "horizontal")` through the page) shows the Home content; a floating side bar closes after its Home button. The Home content itself is still the old dashboard in this worktree; that is expected.
- No live `/verify` suite is run.

### 10.2 DATA: main process data and IPC

**Spec:** `docs/DASHBOARD.md` sections 7 and 9.2. Base: the contract commit on `advenimus/dashboard`.

**Owns (only these files):**
- `electron/services/dashboard/**` except `dashboard-dto.ts` and its mirror test (frozen): for example `connection-history-store.ts`, `vault-key.ts`, `ai-activity.ts`, `reachability.ts`, and tests in `electron/services/dashboard/__tests__/`
- `electron/ipc/dashboard.ts` (new, `registerDashboardHandlers()`), `electron/ipc/index.ts` (one import and one call)
- `electron/services/vault/vault.ts` and `electron/services/vault/database.ts`: add only `listPasswordAges()` and a read-only `peekVaultId()` (reads `vault_meta.vault_id` without creating it) plus their SQL
- `mcp/src/audit.ts` and `mcp/src/__tests__/audit.test.ts` (new)
- `src/lib/connectionHistoryRecorder.ts` and `src/lib/__tests__/connectionHistoryRecorder.test.ts` (new)
- `src/lib/dashboardApi.ts`, `src/main.tsx` (contract files: no API change expected)
- `scripts/verify/capture-dashboard-data.mjs` (new, one-off)

**Build:**
1. Connection history store (spec 7.1): SQLite file `{getDataDir()}/connection-history.db`, the schema and indexes, vault key rules (team `team:<id>`, personal `vault:<vault_id>` via `peekVaultId()`, else `path:<sha256 prefix>`; find the team vault accessor in `electron/services/state.ts` and the team vault manager), retention (90 days, then 5000 rows per vault key; at open and every 50th insert), `open` rows become `interrupted` at open, and `app.on('will-quit')` closes `open` rows as `closed`.
2. IPC handlers for all eight channels of spec 9.2 with argument validation (`Error("Invalid request")`), limits clamped with the constants from `dashboard-dto.ts`, and the locked-vault answers listed there. Register them from `electron/ipc/index.ts`. No preload change is needed (`preload.cts` exposes a generic `invoke`).
3. Recorder `installConnectionHistoryRecorder()` in the renderer (spec 7.2 rules 1 to 6), using `dashboardApi.historyStart` and `historyEnd`. Keep it free of React.
4. `ConduitVault.listPasswordAges()` (spec 7.3), never decrypting. Confirm every path that changes a password calls `recordPasswordHistory` and report any that do not.
5. AI activity reader (spec 7.4) and the new `env` field in `mcp/src/audit.ts`. Do not change any other field or the redaction.
6. Reachability check (spec 7.5): target rules per type, validation, error mapping, 3 s timer, four at once, the 2 s cache and shared in-flight promise. Do not log host names above debug level.
7. Confirm that local backups copy only vault files, not the data dir (spec 7.1 [A]), and report.

**Do not edit:** any file under `src/components/`, `src/stores/`, `src/App.tsx`, `electron/main.ts`, `electron/preload.cts`, `src/types/dashboard.ts`, `electron/services/dashboard/dashboard-dto.ts`.

**Acceptance:**
- Unit tests of spec 11.1 DATA pass (use a temp dir for the SQLite file, a fake socket for error codes, and a real loopback `net.Server` for `reachable` and `refused`); whole `npx vitest run` and `cd mcp && npx vitest run` pass.
- Both `tsc` runs clean, `npm run lint` no errors, `npm run build` passes.
- One app run with `scripts/verify/capture-dashboard-data.mjs`: unlock a vault with an SSH entry pointing at a closed local port and a web entry pointing at the harness test site (`startTestSite` in `scripts/verify/lib/restyle-data.mjs`); open and close the web entry, open the SSH entry and let it fail; then call every channel through `window.electron.invoke` in the page and save the JSON answers to `.verify/dashboard/data/results.json`. Expected: a `closed` web row and a `failed` SSH row in `connection_history_recent`, `reachable` for the test site and `refused` for the closed port, `logFound` as the device has it. Screenshot the app once for the record.
- No live `/verify` suite is run, including the MCP suite.

### 10.3 HOME: Home dashboard content

**Spec:** `docs/DASHBOARD.md` sections 4, 8.1, 8.2 and 9.4. Base: the contract commit on `advenimus/dashboard`.

**Owns (only these files):**
- `src/components/dashboard/DashboardOverview.tsx`, `src/components/dashboard/VaultStatusCard.tsx`, `src/components/dashboard/relativeTime.ts`
- `src/components/dashboard/home/**` (new), for example `QuickBar.tsx`, `quickSearch.ts`, `RecentConnectionsCard.tsx`, `OpenNowCard.tsx`, `FavoritesCard.tsx`, `AttentionCard.tsx`, `attention.ts`, `AiActivityCard.tsx`, `aiActivityLabels.ts`, `CustomizeMenu.tsx`, `useHomeSettings.ts`, `copyPassword.ts`, and tests in `src/components/dashboard/home/__tests__/`
- `src/components/dashboard/__tests__/DashboardOverview.test.tsx`
- `scripts/verify/capture-dashboard-home.mjs` (new, one-off)

**Build:**
1. `DashboardOverview`: header (4.1) with the "Welcome back" heading kept, then the sections in the order and grid of section 4, each hidden when turned off or empty. Move the empty-vault welcome block from `PaneContent` into `DashboardOverview` (shown when there are no entries and no folders; strings unchanged). Keep each file under 400 lines.
2. Quick bar (4.2) with the pure `searchQuick` and the combobox keyboard rules.
3. Recently connected (4.3), Open now (4.4, uses `focusSession`), Favorites as today (4.5).
4. Needs attention (4.6) with the pure `buildAttentionItems`, the password list, and actions (`openView`, `conduit:settings` with a tab, `auth_open_pricing`).
5. AI activity (4.7) with polling every 30 s while the document is visible.
6. Vault status (4.8): Overview adds the Command tile.
7. Customize (4.9) with `useHomeSettings` (`ui_state_get`/`ui_state_set`, key `home-dashboard`, field-by-field fallback) and Clear connection history.
8. Loading and errors (4.10): no toasts for background loads.
9. Read data only through `dashboardApi`; open things only through `openEntry`, `openDashboardForEntry`, `openFolderView` and `focusSession`.

**Do not edit:** `src/components/layout/**`, `src/stores/**`, `src/lib/**`, `EntryDashboard.tsx`, `FolderDashboard.tsx`, `EntryDetailParts.tsx`, `src/components/dashboard/__tests__/fixtures.ts`.

**Acceptance:**
- Unit tests of spec 11.1 HOME pass (mock `src/lib/dashboardApi`); whole `npx vitest run` passes.
- Both `tsc` runs clean, `npm run lint` no errors, `npm run build` passes.
- One app run with `scripts/verify/capture-dashboard-home.mjs` in dark and light mode (screens under `.verify/dashboard/home/`). The DATA handlers are not in this worktree, so the script registers temporary fake handlers for the eight channels with `mainEval` (`ipcMain.handle`) before unlocking, returning fixture data typed by `src/types/dashboard.ts`. Capture: Home with every section filled, the search with results and an active row, Needs attention with the password list open, the Customize popover, Home with two sections hidden, and the empty-vault welcome.
- No live `/verify` suite is run.

### 10.4 PANELS: folder view and entry info additions

**Spec:** `docs/DASHBOARD.md` sections 5, 6, 8.2 to 8.5 and 9.4. Base: the contract commit on `advenimus/dashboard`.

**Owns (only these files):**
- `src/components/dashboard/FolderDashboard.tsx` and `src/components/dashboard/folder/**` (new), for example `FolderEntryList.tsx`, `folderList.ts` (pure filter, sort and sub-folder paths), `OpenAllButton.tsx`
- `src/components/dashboard/EntryDashboard.tsx`, `src/components/dashboard/EntryDetailParts.tsx` and `src/components/dashboard/entry/**` (new), for example `ReachabilityRow.tsx`, `ConnectionHistorySection.tsx`, `historyFormat.ts`
- `src/components/dashboard/reachability/**` (new): `reachabilityCopy.ts`, `useReachability.ts`, a small concurrency helper
- `src/components/entries/EntryTree.tsx`
- `src/lib/openDashboard.ts` (contract file: keep its exports as they are)
- Tests: `src/components/dashboard/__tests__/FolderDashboard.test.tsx`, `EntryDashboard.test.tsx`, tests in `folder/__tests__/`, `entry/__tests__/`, `reachability/__tests__/`, and `src/components/entries/__tests__/EntryTree.test.tsx`
- `scripts/verify/capture-dashboard-panels.mjs` (new, one-off)

**Build:**
1. Folder view (spec 5): header with Check all, Open all and New Entry; type cards kept; distribution bar, Recent Activity and Entry Age removed; search, "Sort by" select, the recursive list with sub-folder paths, row meta (reachability badge, last connected from `dashboardApi.historyRecent({ limit: 50 })`) and trailing actions; Open all with the confirm above 5 and the skipped types; Check all with at most 50, four at a time, the progress label and the cap toast.
2. Reachability (spec 7.5 from the renderer side, 8.3): `useReachability` calls `dashboardApi.checkReachability`, keeps results per mounted view, runs `checkMany` four at a time and disables a row while it checks. `reachabilityText` gives the badge, tone and detail for every status.
3. Entry info (spec 6): the "Is it up?" row after Host with the always-visible hint and its port rule; the Recent connections section from `dashboardApi.historyForEntry`. Replace the literal `dashboard::` in `handleOpen` with `entryInfoSessionId`.
4. `EntryTree`: folder context menu gets `{ id: "view_info", label: "View Info", icon: "infoCircle" }` as its first item for every role, followed by a separator when more items follow, calling `openFolderView(node.id)`. The entry "View Info" item switches its icon from `home` to `infoCircle`.

**Do not edit:** `DashboardOverview.tsx`, `VaultStatusCard.tsx`, `relativeTime.ts` (import it if useful), `src/components/dashboard/home/**`, `src/components/layout/**`, `src/stores/**`, other `src/lib/**` files, `src/components/dashboard/__tests__/fixtures.ts`.

**Acceptance:**
- Unit tests of spec 11.1 PANELS pass (mock `src/lib/dashboardApi`); whole `npx vitest run` passes.
- Both `tsc` runs clean, `npm run lint` no errors, `npm run build` passes.
- One app run with `scripts/verify/capture-dashboard-panels.mjs` (screens under `.verify/dashboard/panels/`). The DATA handlers are not in this worktree, so the script registers temporary fake handlers with `mainEval` (`ipcMain.handle`) for `reachability_check`, `connection_history_recent` and `connection_history_for_entry`, returning fixture data typed by `src/types/dashboard.ts` (mix of statuses). Capture: the folder menu with View Info, the folder view with badges after Check all, the Open all confirm, a sorted and filtered list, and an entry info tab with a check result and Recent connections.
- No live `/verify` suite is run.

## 11. Test plan

### 11.1 Unit tests (by package)

- **NAV**: Home cannot be closed, removed (except `clearAll`), dragged, moved, split or reordered away from index 0; other tabs cannot land before it; Ctrl+W on Home does nothing; `openHome` creates, focuses and collapses a floating side bar, and does nothing while locked; the guard recreates Home after `clearAll` plus `resetLayout` while unlocked, and not during `lockVault`; the shortcut dispatches `conduit:home`; the empty pane renders Home; the Home tab has no close button, no status dot and no menu; a folder tab shows the folder icon; the side bar Home button calls `openHome`.
- **DATA**: store schema, start and end, outcomes, recent grouping and counts, per-entry list, clear, vault key rules, retention by age and row cap, `interrupted` on open and `closed` on quit; recorder rules 1 to 6 with a fake `dashboardApi`; password ages with and without history, linked credentials excluded, locked gives `[]`; AI activity tail reading, partial first line, bad lines, env filter with legacy lines in both environments, parameter whitelisting, limit clamp, missing file; reachability target rules per type, validation, each error code mapping (with a fake socket), timeout, concurrency cap, the 2 s cache and shared in-flight promise, and a real loopback server for `reachable` and `refused`; MCP audit lines carry `env`; IPC argument validation.
- **HOME**: quick search ranking, limit, keyboard (down, up, wrap, Enter, Escape twice), open rules per result type; each attention kind on and off at its threshold, order, pluralization and the password list; settings parsing and fallback; sections hide when hidden or empty; Customize saves through `ui_state_set`; Clear connection history confirm and toasts; Recently connected rows, Copy password toasts, View info; Open now rows and `focusSession`; AI activity labels, targets, badges and polling with fake timers; Overview includes Command; empty vault shows the welcome block.
- **PANELS**: folder view list recursion, search, each sort, sub-folder path text, row actions, Open all threshold and skipped types, Check all cap, order and concurrency (four at a time) and the progress label; reachability texts for every status; entry info "Is it up?" states and hint port; Recent connections rows, durations, outcome labels and empty text; EntryTree folder menu has View Info first and it calls `openFolderView`; entry View Info uses the `infoCircle` icon.

### 11.2 After merge (lead)

1. `npx vitest run`, `cd mcp && npx vitest run`, both `tsc` runs, `npm run lint`, `npm run build`.
2. One app run with a one-off capture script: unlock a vault with a few entries, favorites, a sub-folder and a password older than 180 days; check Home (all sections, then Customize hiding two sections), the search results, the pinned tab with no close button, Cmd+Shift+H from a session, lock and unlock (Home comes back), a folder view with a check and Open all confirm, and an entry info tab with a check and history.
3. Known follow-up, needs a live run: refresh the restyle suite's `home-dashboard-full-window` inventory (its allowed delta in `scripts/verify/fixtures/restyle/allowed-deltas.json`) and the composite of shot 40 with `node scripts/verify/run.mjs restyle --strict --only tabs`. The harness side is ready: `closeAllSessions` leaves only Home, and the suite clears the connection history before shot 40.

## 12. Known limits

- **Password ages after a vault import.** Importing a Conduit vault export (`electron/services/vault/export-import.ts`) creates new entries and does not bring their password history, so an imported password counts from the import time.
- **Password ages in a team vault.** A team sync pull (`electron/services/vault/team-sync.ts` `mergeCloudEntry`) applies a newer password without writing a history row on this device. The age is right once the other device's `vault_password_history` row arrives (Realtime or the next reconcile); until then, or when that row never reached the cloud, the entry shows the age of its previous password.
- An RDM import that overwrites a duplicate records the old username and password in password history, like the entry edit path (`overwriteEntry` in `electron/services/import/rdm-importer.ts`).
