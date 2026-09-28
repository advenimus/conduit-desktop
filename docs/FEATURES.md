# Conduit Features

> **Auto-maintained**: This document is updated whenever a new feature is implemented.
> Last updated: 2026-09-26

---

## Connection Types

### SSH (Terminal Sessions)
- Username/password and SSH key authentication
- **Keyboard-interactive fallback**: Automatically answers keyboard-interactive prompts with the configured password, so servers that advertise only keyboard-interactive (e.g. VMware ESXi) connect successfully
- **SSH auth method selection**: When a credential has both an SSH key and a password, choose which method to use per-credential or per-entry (default: SSH key)
- **Global SSH auth default**: Configurable in Settings → Sessions → SSH — sets the default auth method when both key and password are present
- Auto-detection of local SSH keys (~/.ssh/id_rsa, id_ed25519)
- Real-time terminal via xterm.js + node-pty
- Terminal buffer reading with configurable history
- Dynamic terminal resize (cols/rows)
- Multi-session support with tabbed interface

### RDP (Remote Desktop)
- FreeRDP 3.x native engine via C helper binary (conduit-freerdp)
- Resolution presets: match window, 1920x1080, 1280x720, 1440x900, custom
- Color depth: 32/24/16/15-bit
- Sound routing: local, remote, or disabled
- Quality presets: best, good, low (controls visual fidelity vs. performance)
- Bidirectional clipboard sync (text) via CLIPRDR channel, per-entry toggle
- Bidirectional file clipboard transfer via MS-RDPECLIP file stream protocol
  - Local → Remote: copy files on local machine, Ctrl+V (or right-click paste) in remote Windows desktop
  - Remote → Local: copy files in remote Explorer, download notification with file list appears in session
  - Real-time progress bars for both upload and download transfers with file size display
  - Multi-file and directory support (nested directory structures preserved)
  - Large file support (>4GB via 64-bit offsets, chunked 256KB transfers)
  - Theme-aware progress UI across all color schemes
  - Dismiss notification with proper backend state cleanup
- DNS resolution fallback: dual-strategy hostname resolver (OS `dns.lookup` → c-ares `dns.resolve4`) for corporate Windows environments where standard resolution fails
- NLA (Network Level Authentication) support
- Certificate verification bypass
- Actionable connection error messages: failures surface a specific cause and suggested fix (e.g. credentials, NLA, host reachability) instead of a generic error
- Shared folder redirection with per-drive read-only enforcement
- Dynamic display resizing via RDPEDISP channel
- High DPI / Retina display support (per-connection toggle, physical pixel resolution + DPI scale factors)
- **Display Scale slider**: Global setting (Settings → Sessions → RDP) to manually adjust the effective resolution from 50% to 200% in 5% steps — higher scale = bigger objects, lower = smaller. Active RDP sessions automatically reconnect on change for instant feedback.
- Mouse: click, double-click, drag, scroll, hover tracking
- Keyboard: full key press/release, text input
- Screenshot capture (PNG/JPEG, quality control, regional capture)
- Bitmap caching, server pointer rendering
- Hostname override for multi-homed servers
- Send Ctrl+Alt+Delete via RDP tab context menu

### VNC (Virtual Network Computing)
- Password authentication via rfb2 client
- Bidirectional clipboard sync (text) via cutText/clientCutText
- Mouse: click, double-click, drag, scroll, movement
- Keyboard: key press/release, text input
- Screenshot capture (PNG/JPEG, quality control)
- Session dimensions query
- Full frame request/refresh

### Web Sessions (WebContentsView / WebView2)
- Native Chromium webview (not iframe)
- **Edge/WebView2 engine** (Windows only): Uses Microsoft Edge WebView2 for native Windows SSO/WAM integration
  - Enables M365 SSO on domain-joined machines (ServiceNow, SharePoint, Outlook Web, etc.)
  - C# helper binary (`conduit-webview2.exe`) hosts WebView2 as Win32 child window parented to Electron HWND
  - Named pipe JSON protocol for bidirectional communication
  - Full WAM/PRT injection (automatic single sign-on via Windows Web Account Manager)
  - Graceful fallback to Chromium when WebView2 Runtime is unavailable
- **Per-entry engine selection**: Auto / Chromium / Edge-WebView2 in entry security settings (Windows only)
- **Global default engine**: Configurable in Settings → General (Windows only)
- Engine resolution chain: per-entry override → global default → auto (prefers WebView2 on Windows)
- Certificate error bypass per-session
- Screenshot capture and content extraction
- Content reading by CSS selector (text/HTML/markdown)
- Multi-step login support with URL pattern matching
- Session positioning and resizing
- Full AI interaction: coordinate-based click, type, scroll, drag, mouse move, send key (matching RDP/VNC interaction model)
- DOM-aware tools: click element by CSS selector, fill input with React/Vue/Angular event dispatch, discover interactive elements, execute arbitrary JavaScript
- Coordinate auto-scaling from screenshot image space to viewport CSS pixels
- Get viewport dimensions query
- **Multi-tab browsing**: Up to 12 tabs per web session with browser-like tab management
  - Sub-tab bar with tab switching, close buttons, favicons, and loading indicators
  - Drag-to-reorder tabs within a session
  - New tab button creates tab from session's original URL
  - Tab state tracking: URL, title, favicon, loading state, navigation history, HTTPS status
- **Browser navigation toolbar**: Full address bar with back/forward/stop/refresh/home controls
  - Click address bar to edit URL, press Enter to navigate (auto-prepends `https://`)
  - URL display without protocol prefix, HTTPS lock/unlock security indicator
  - Home button returns to original session URL
- **Autofill with selector picker**: CSS selector-based autofill for login forms
  - 3-step guided wizard: click username field → password field → submit button to capture selectors
  - Review step shows picked selectors before saving
  - Skip/Done buttons for partial configuration
  - Autofill bar with fill/pick controls and status indicator (idle/filling/success/error)
  - Persists selectors to credential entry for future one-click autofill
- **Download management**: Browser-like download prompt for both Chromium and WebView2 engines
  - Toast notification with file name and size when a download is triggered
  - **Open**: Downloads to temp directory, then opens with OS default application
  - **Save As**: Shows native save dialog, downloads to chosen location
  - **Cancel**: Cancels the download and cleans up temp files
  - Real-time progress bar with percentage, bytes transferred, and download speed
  - Works on both Chromium (all platforms) and Edge/WebView2 (Windows) engines
  - Multiple simultaneous downloads supported with independent progress tracking

### Command (Local Execution)
- Run any local command or script as a Conduit entry
- Command, arguments, working directory, and shell (bash, zsh, sh, PowerShell, cmd) configuration
- Run As mode: credential user (cross-user execution via stored credential) or current user
- GUI application toggle with platform-specific guidance (Fast User Switching on macOS, automatic on Windows)
- Configurable timeout (0 = no timeout)
- Read-only terminal output via xterm.js with status overlay (running / exited / error / timeout) and exit code display
- Restart and stop controls in session toolbar
- Windows: native `CreateProcessWithLogonW` (koffi) for cross-user process creation (no PowerShell shim)

### Documents (Markdown)
- Create and edit markdown documents directly in Conduit
- Full-featured markdown editor with formatting toolbar (bold, italic, headings, code, tables, lists, blockquotes, links, images, secrets)
- Split-pane editing: live preview alongside editor
- View mode: full-width rendered markdown
- Unsaved changes indicator with discard confirmation
- Word count display
- Content stored in vault alongside connections and credentials
- Web URL images supported via standard markdown syntax
- Available on all tiers

---

## Vault & Credentials

### Encryption
- AES-256 encryption via better-sqlite3
- Master password-based key derivation
- Per-vault encrypted database (local file)

### Entry Types
- SSH, RDP, VNC, Web connection entries
- Document entries (markdown notes, runbooks, documentation)
- Standalone credential entries (reusable across connections)
- **Categorized type selector**: New Entry dialog groups types into categories (Connections, Documents, Credentials) with descriptions for each type
- Credential sub-types (Password, SSH Key) open dedicated credential form with vault unlock handling

### Credential Management
- Username/password storage
- SSH private key storage
- Windows domain credentials
- Credential picker for linking to connection entries
- Tags for organization
- **Credential types**: Typed credentials with extensible type system
  - **Generic**: Default type for username/password/domain/private key
  - **SSH Key**: Stores public key and fingerprint alongside private key; auto-set when generating keys via SSH Key Generator
  - Type badge shown in credential list and picker for non-generic types
  - Type selector in credential form (segmented button group)
  - SSH key metadata section (public key with copy button, read-only fingerprint) shown when SSH Key type selected
- **TOTP (One-Time Password)**: Optional MFA/TOTP support on generic credentials
  - TOTP secret encrypted at same level as passwords (AES-256-GCM)
  - Two setup paths: import QR code image, or manually enter Base32 secret key
  - QR code decoder (reads PNG/JPG/GIF/BMP/WebP images via `jsqr` + `sharp`)
  - Live TOTP code preview in credential form with real-time countdown
  - Dashboard display: large monospace code with circular SVG countdown arc and copy button
  - Issuer, account, algorithm (SHA1/SHA256/SHA512), digits (6/8), and period stored as metadata
  - Auto-refreshes every second with visual countdown indicator (turns red at 5s)
  - Works with team vault sync (encrypted with VEK alongside other secrets)
  - MCP tools include `has_totp` flag in credential list/read responses

### Entry Organization
- Hierarchical folder structure (unlimited depth)
- Move entries between folders
- **Nested entries**: Any entry can be nested under another entry — e.g. drop a credential onto a web session, an SSH command under a host, a document under a project. Children promote to the parent's container when the parent is deleted, so nothing is orphaned.
- **Multi-select**: Ctrl/Cmd+Click to select multiple entries and folders
- **Batch drag-and-drop**: Drag multiple selected items into a folder (or onto a parent entry) at once, with "N items" badge on drag
- Circular reference protection (cannot drag a folder into its own descendant, or an entry under itself)
- Team vault permission enforcement on batch moves (insufficient-permission items skipped with toast)
- Root drop zone below tree for moving items to top level
- **Recursive folder deletion**: Deleting a folder deletes all its contents (subfolders + entries) with a confirmation dialog showing the total item count
- Multi-delete with count confirmation dialog (Delete/Backspace key)
- Multi-select context menu with batch delete option
- Click empty tree area to clear selection
- Drag disabled in search/favorites flat-list mode
- Favorite/star marking with visual star indicator in tree
- Favorites filter toggle (star button in sidebar header and rail)
- Independent folder expand/collapse state for all vs. favorites view
- Favorites filter persisted across app restarts
- Sort order customization
- Custom icons (icon picker with library)
- Custom colors (color picker)
- Tags, descriptions
- Markdown notes with GitHub-style Write/Preview editor, formatting toolbar, and `!!secret!!` syntax for masking sensitive inline text

### Auto-Lock
- Manual lock via menu or Cmd+Shift+L
- Optional "Lock the vault when idle" in Settings > Security: Off (default), 5, 15 or 30 minutes, or 1 hour
  - Any other whole number of minutes stored in settings.json shows as "Custom (N min)" and is kept when Settings is saved
- While it is on, the personal vault also locks when the computer's screen locks
- Uses system idle time (checked every 30 s); applies to personal vaults only, never to an active team vault
- An automatic lock is a normal lock: open connections close and the app returns to the locked state

### Quick Unlock (Biometric)
- **Touch ID / Apple Watch unlock** (macOS): Unlock personal vaults using Touch ID, Apple Watch, or system password instead of re-entering the master password
- Uses macOS LAContext `deviceOwnerAuthentication` policy via compiled Swift helper binary (supports Touch ID, Apple Watch, and passcode fallback)
- Master password stored encrypted in macOS Keychain via Electron's `safeStorage` API
- Per-vault biometric enrollment — setup prompt appears after first successful password unlock
- Dismissed prompt tracking per vault (switching vaults re-prompts)
- Quick Unlock button in UnlockDialog for manual re-trigger after auto-prompt
- Fingerprint badge on biometric-enabled vaults in Vault Hub
- Settings > Security tab with Quick Unlock toggle (macOS only)
- Auto-updates stored password on vault password change
- Stored per vault identity (lineage), with the old per-path key as a fallback, so a synced vault keeps Quick Unlock after a rename or move
- A stored password made stale by a password change on another device is removed, and the user is asked for the new password
- Cleans up biometric data when removing vaults from recents (both the vault-identity key and the old per-path key); "Clear All" removes every stored entry
- Team vaults excluded (VEK-based, no master password)
- Zero new npm dependencies — uses Electron built-in + compiled Swift binary
- Windows Hello support planned as follow-up

### Vault Management
- **Rename Vault**: Rename personal or team vaults from File > Rename Vault while unlocked; personal vaults rename the `.conduit` file on disk, team vaults update the name in Supabase (vault admin or team admin required)
- **Manual Save**: File > Vault Management > Save Vault (Ctrl+S / Cmd+S) forces a WAL checkpoint, flushing all data into the `.conduit` file for portable backup; shows informational toast for team vaults (saved to cloud automatically)

### Local Backup
- Encrypted local folder backup with AES-256-GCM (domain-separated from cloud/vault encryption)
- User-selectable backup folder via native OS folder picker
- Debounced automatic backup on vault mutation (5s after last change)
- Manual "Backup Now" trigger
- Configurable retention period (default 30 days) with automatic pruning
- Atomic writes (write to .tmp, then rename) for crash safety
- Backup file list with timestamps, sizes, and per-file delete
- Periodic prune every 6 hours for long-running sessions
- Descriptive error states (ENOENT, EACCES, ENOSPC)
- No authentication required — works with just the master password
- Dedicated "Backup" settings tab consolidating all backup functionality

### Multi-Device Sync (Personal Vaults)
Full design: `docs/MULTI_DEVICE_SYNC.md`. Code: `electron/services/sync/` (merge engine) and `electron/services/vault-session/` (device leases and limits).
- **The vault file is the transport**: keep a personal `.conduit` vault in iCloud Drive, OneDrive, Dropbox, Google Drive or a network share and open it on several devices. Sync data lives inside the file; Conduit's servers never hold vault content
- **Private working copy**: each device edits a private copy in app storage and publishes whole-file snapshots to the shared file, so no `-wal`/`-shm` files are left in cloud folders
  - A publish keeps the shared file's permission bits (a new shared file is owner-only), and the local sync folder is owner-only. Windows ACLs set on the shared file are not copied
- **Per-field merge on every plan**: edits from different devices merge field by field. Plans only limit how many devices can have a vault open at once
- **Conflict queue**: two devices setting the same field differently creates a conflict for the user to pick. Sidebar shows "N to review", tree items get an amber dot, and the entry view and editor show each conflicted field inline
- **Conflict review panel**: pick a value per field; appearance fields (icon, color and similar) come preselected to "Keep newest"
  - Notes and documents show every version in full with line breaks; locations and linked credentials show folder and item names; favorites and tags read Yes/No and Tagged/Not tagged
  - "Enter a different value" is offered for text fields only; a document or setting typed here is stored as valid JSON
  - Saving from the entry editor sends only the fields you changed, so a choice made in the review panel meanwhile is kept
- **Recently deleted**: deleted items keep a tombstone until "Delete permanently" (with a confirm); they can be restored
  - "Delete all permanently" is off when every listed item is already erased
- **Safety nets**: pre-merge snapshots with a targeted undo for large changes, a preview before restoring a backup into a synced vault, and a preview before merging any copy that could revert or delete data
  - Undo reports what it restored: one change per item brought back plus one per field set back ("Undid 13 changes." for a folder and its 12 entries)
  - A backup rollback counts the same way, as its preview lists it: one per item deleted or brought back and one per value replaced ("Rolled back 2 changes." for one entry and one password)
  - The merge preview says what Merge will do: for a copy with sync history it applies the copy's edits and deletions, and only items your vault also changed come back for review
- **Other copies**: cloud "conflicted copy" files and duplicates are found and merged only when that is safe; everything else is offered for review. No file is moved or deleted without a click
  - A copy that only another device had open (its presence, no edits) counts as "Nothing new": listed under Other copies, no notice. A copy this device cannot count (another password) says it "may hold changes" instead of "0 changes"
- **Older desktops' side files** (`-wal`/`-shm` next to the shared file) pause publishing until "Conduit is closed on my other computers"; publishing resumes right after that click, even while other devices' session rows still show the side-files flag they reported before it. A flag reported after the click (timed by the row's heartbeat, so also from an idle device) pauses again, and a flag that clears at a heartbeat starts a sync at once
- **Where a device syncs**: the devices list names the provider ("syncs in iCloud Drive"); a macOS `/Volumes/...` path or a Windows network share reads "syncs on an external or network drive"
- **Moved or renamed shared file**: after 30 s missing, a device rebinds by itself when exactly one file of the same vault with a normal name is in the folder (toast with Undo); otherwise it offers Locate, Keep working and Save a new copy here. The app's vault path, the recent vaults list and the window follow the new file, so a relaunch opens it. Renaming from File > Rename Vault renames only the shared file
- **Older apps**: edits made by older Conduit builds (desktop 0.17 and earlier, iOS 1.0.5) are absorbed on the next read
- **Master password changes**: a change on one device reaches the others; they ask for the new password, and for the previous one when needed. After "Later", a banner keeps "Enter password" one click away while syncing is paused
  - Change Password on a synced vault offers "Also permanently delete items in Recently deleted", which erases them on every device (recommended when the old password may have leaked)
- **Waiting for the drive**: while the cloud drive has not delivered another device's latest changes, a dialog or banner says so
- **Settings > Sync**: plan line, Sync now, devices list and review tools. Sync is always on; there is no user-facing on/off switch, because turning the engine off would let a signed-out Free device skip the one-device rule
  - Support can still turn sync off on one device (`personal_sync_enabled: false` in settings.json, or the `sync_set_enabled` channel, which refuses while changes are unpublished). Vault Hub then marks recent vaults with "Changes not yet synced" and warns at start when changes exist only on this device (Turn sync back on / Export them)
- **Server kill switch**: the `personal_sync` plan key set to `paused` stops merging and publishing; every edit stays in the working copy
- **Backups of synced vaults** are taken from a snapshot of the working copy
- Team vaults are unchanged: they keep team sync and never use the personal engine or device leases

### Device Limits (Personal Vaults)
- **Rule**: a personal vault can be open (unlocked) on `vault_max_open_devices` devices at once. Free (also signed-out and local mode) = 1; Pro and Team = unlimited
- **Signed in**: a server lease in `personal_vault_sessions` (90 s time limit, 30 s heartbeat, Realtime for fast notice). Signed out: an owner claim stored inside the vault file
- **Open on another device**: the unlock shows which device has it and offers "Use here instead"
- **Soft lock when displaced**: the other device shows "Opened on iPhone. Saving your last changes..." while it saves and publishes, then locks the vault. Its open terminals, RDP, VNC, web sessions and running commands keep running. MCP vault calls get a locked error with reason `open_elsewhere`
  - The notice names the device that took over, also on its first take-over (the name is asked from the server when this device has not seen that device yet), and says what keeps running ("Your 1 open connection and 1 AI task are still running.")
  - Busy counts shown to other devices: open connections, and AI tasks only while they run (a chat turn in progress, or an agent terminal that had input and then input or output in the last 2 minutes). An idle agent panel is not a running task
- **Offline never locks anyone out**: without a server answer the app uses the last confirmed limit; a cached Pro plan is honored for up to 7 days offline
- **Plan downgrade**: extra devices are displaced, keeping busy devices first, then the most recently active
- **Session conflict on reconnect**: a dialog with a 60 s countdown; with no answer this device soft-locks. If the server cannot be reached, the device keeps working
- The lease is released on lock, window close, quit (also before an update installs, since the Windows installer does not wait) and sign-out (released before the account signs out, while the server can still be reached)
  - A lock or quit during an unlock cancels its waits and closes what it opened, so the vault never ends up unlocked after a lock. A lock during a displaced save waits for that save
- **Dev testing**: `CONDUIT_DEV_VAULT_DEVICE_LIMIT` (for example `-1`) forces the device limit in unpackaged builds when no confirmed server answer applies, so two signed-out dev builds can test concurrent sync without Supabase. Packaged builds ignore it
- **Dev testing offline**: `CONDUIT_DEV_SUPABASE_URL` (an http(s) loopback URL such as a local proxy) replaces the preview Supabase URL in unpackaged builds, so one test instance can lose Supabase while others keep it (`scripts/verify` uses it). Packaged builds and the production environment ignore it

### Team & Shared Vaults (Zero-Knowledge)
- **Zero-knowledge encryption**: X25519 identity key pairs per user-device, ECIES VEK wrapping
- **Vault Encryption Key (VEK)**: Per-vault 256-bit AES key, wrapped individually for each authorized user
- **Recovery passphrase**: 6-word BIP39-style passphrase for cross-device key backup
- **Device authorization**: Approve new devices from existing ones via device-to-device key transfer
- **Team entity management**: Teams with admin/member roles, invitation system with accept/decline
- **Team vaults**: Create and share encrypted vaults within a team (no shared password)
- **Entry-level cloud sync**: Supabase Realtime for live entry/folder updates across devices
- **Offline mutation queue**: Queues changes when offline, flushes on reconnect (1000 op cap)
- **Optimistic concurrency**: Version-checked writes with last-write-wins conflict resolution
- **Full reconciliation**: Periodic 5-minute sync to catch missed Realtime events
- **VEK rotation**: Re-encrypt all entries when a member is removed
- **Pro vault locking**: Exclusive lock with 60s TTL and 30s heartbeat (Team plan: concurrent access)
- **Network share advisory locking**: .lock file with stale detection for shared-drive vaults
- **Network file watcher**: mtime polling (3s) for network paths, fs.watch() for local paths
- **Folder-level permissions**: Admin/editor/viewer roles per folder with restrict-only inheritance (folder overrides can only downgrade, never escalate beyond vault role)
- **Audit trail**: Fire-and-forget logging of all team vault mutations (entry/folder CRUD, member add/remove/role change, vault create/access/key rotation, folder permission grant/revoke, invitation accept/decline), filterable log viewable by admins, 2-year retention policy with automatic server-side purge
- **Sync status indicator**: Real-time sync state in sidebar (synced/syncing/offline/error)
- **Team invitation banner**: Amber notification in sidebar for pending team invitations
- **Unified vault switcher**: Combined personal and team vault dropdown with active indicator, member counts, and quick-switch between vault types
- **Team vault creation from desktop**: Create team vaults directly from the vault switcher or Team settings tab (admin only), with automatic identity key generation if needed
- **Team vault member management**: Full CRUD dialog for vault members — add from team roster, change roles (admin/editor/viewer) via dedicated update IPC, remove members, rotate vault encryption key, and last-admin protection
- **Identity key onboarding**: Auto-detect new devices that need identity key setup, with recovery passphrase entry or device-to-device authorization
- **Team vault context bar**: Theme-aware accent bar shown when a team vault is active, displaying sync status, member count, and quick-access buttons for members/audit/settings
- **Theme-aware team indicators**: Team vault accent colors derived from the active color scheme (Ocean, Ember, Forest, Amethyst, Rose, Midnight) via CSS custom properties
- **Device authorization approval**: Auto-polls for pending device auth requests every 30s, shows approval dialog with approve/deny actions on existing devices
- **Folder permission editor**: Right-click folders in team vaults to manage per-member permissions (admin only) — add, change role (filtered by vault role ceiling), or remove access
- **Vault Hub**: Full-screen landing page on launch (like VS Code Welcome) showing team vaults and recent personal vaults; auto-connects to last team vault for team-plan users when online; fallback to hub on offline, error, or personal vault last used; lock/close vault returns to hub instead of showing unlock dialog; offline team vaults shown greyed with "Offline" badge; "Switch Vault..." option in vault dropdown
- **Vault settings dialog**: Centralized tabbed dialog (Members + Folder Permissions) accessible from context bar, replaces separate member/permission dialogs
- **Auto-enrollment of team admins**: Team admins are automatically enrolled in new vaults at creation time; promoted members are enrolled in all existing vaults; late-joining admins (who set up identity keys after vault creation) are auto-enrolled when any existing admin opens the vault
- **Client-side permission enforcement**: Viewers see disabled create buttons, filtered context menus (no edit/delete), read-only warning banners in dialogs, and lock icons on restricted folders
- **Effective role computation**: `min(vault_role, folder_override)` with restrict-only semantics — folder permissions can only downgrade access, enforced both client-side and via Supabase trigger
- **Cascading role downgrade**: When a vault member's role is reduced, folder permissions exceeding the new ceiling are automatically pruned
- **Pro vault lock dialog**: When a Pro-tier user tries to open a vault locked by another user, shows lock holder info with retry/upgrade options
- **Admin onboarding card**: Dismissible sidebar prompt for team admins with no vaults, guiding first vault creation
- **Empty state guidance**: Non-admin team members see helpful text explaining that admins create vaults; Team settings shows admin names to contact
- **Network vault indicator**: Auto-detects vaults on network shares and shows a network icon in the vault switcher with tooltip
- **Vault entry isolation**: Switching vaults fully isolates entries — sidebar shows only the active vault's entries, folders, and credentials
- **Vault context in dialogs**: Entry and folder creation/edit dialogs show which vault the item will be saved to (personal vault filename or team vault name with badge)
- **Team vault empty state**: Fresh team vaults display a dedicated empty state with guidance text instead of the generic "No entries yet"
- **Team vault tier skip**: Team vault entries are exempt from personal tier connection limits

### Cloud Backup
Whole-file encrypted backups to Supabase Storage. This is a backup, not the sync transport (see Multi-Device Sync).
- Pro and Team only (`cloud_sync_enabled` plan key); the Backup tab shows a "Pro and Team" badge
- Plan checked on enable, on every restore, when the service starts at unlock, and before each upload, so a downgraded account stops uploading. Each check reads the plan from Supabase again (the profile loaded at sign-in can be an hour old), so a downgrade while the app is open stops uploads at the next upload or unlock and a press of the toggle is refused with "Cloud backup needs the Pro or Team plan."
- Periodic automatic backup and manual trigger
- Mutation tracking for incremental backups
- Restore from cloud backup with master password validation
- Restoring into the vault the sync engine is running offers a preview, a rollback, or restore as a new vault (a plain file overwrite would be undone by the next merge). A synced vault that is not open is refused with "Open and unlock this vault first". Private vaults (inside the data folder) keep the whole-file replace
- Enable/disable toggle (persisted in vault metadata); the new-vault form's "cloud backup" box (checked by default on Pro and Team) turns it on at creation, and a vault turned on while empty uploads its first backup after its first edit, so no backup is of an empty vault
- Backup snapshot names carry milliseconds and a random tag, so two uploads in the same second each keep a snapshot
- Cloud backup status indicator (idle, syncing, synced, error)
- Time-based backup retention: 14 days (Pro), 6 months (Team)
- Automatic pruning of backups older than retention period
- Cross-vault backup history: view and restore backups from all cloud-backed vaults, grouped by vault name
- Dedicated Backup Manager dialog with vault sidebar, date-grouped backup list, and cross-vault restore

---

## AI & Chat

Conduit ships with a unified engine architecture that hosts external CLI
agents as native terminals and exposes all Conduit capabilities to those
agents via an MCP server. There is no built-in Conduit AI model. Users
bring their own agent subscription.

### Engine Architecture
- CLI engines: **Claude Code**, **Codex**, **Grok Build**, **Cursor Agent**, **OpenClaw**, **Gemini CLI**, **GitHub Copilot**, and **OpenCode**, each running under the user's own subscription
- Engine selector in the chat panel header and Settings → AI with brand icons
- Claude Agent SDK integration: async generator streaming with rich structured output
- Codex App Server integration: JSON-RPC over stdin/stdout child process
- Rich message blocks: text (markdown), tool calls, file edits, file creates, shell commands, approval requests
- Engine availability detection (CLI installed + authenticated checks)
- Approval flow for agent operations (approve/deny inline in chat)
- Default engine setting (persisted in settings, applied on startup)
- Default working directory for agent sessions
- Slash commands: `/model`, `/clear`, `/cost`, `/help` with autocomplete popup
- Per-session token usage tracking (input + output tokens)
- System messages for command feedback (distinct styling from agent responses)
- Edit/retry for engine messages (edit user messages or regenerate assistant responses)
  - Claude Code: clears SDK session context and resends from edit point
  - Codex: uses `thread/rollback` to preserve context before the edit point
- Conversation history is owned by the underlying CLI (Claude Code / Codex) — the desktop app no longer maintains its own duplicate history layer

### CLI Agent Terminals
- CLI agents always launch as native terminals (the rich chat interface and its toggle have been retired)
- Launch commands: `claude`, `codex`, `grok`, `cursor-agent` (Cursor; falls back to a verified `agent` binary), `openclaw tui --local`, `gemini`, `copilot`, `opencode`
- Working directory: explicit cwd, then Settings default, then `{userData}/conduit[-dev]/agent/{engine}/`
- Configurable terminal font size
- MCP tool access: the agent connects to Conduit via the MCP server. Settings > AI includes an "MCP Server Setup" button that shows the setup command or config snippet for each supported CLI
- Managed agent directories get a project MCP config pointing at the running build's socket: `.mcp.json` for every CLI, plus `.cursor/mcp.json` for Cursor and `.codex/config.toml` for Codex (Codex loads it once the folder is trusted, and it overrides any global `conduit` entry)

### Tier System
- `cli_agents_enabled`: CLI agent access (all tiers — under the user's own agent subscription)
- `mcp_enabled`: MCP tool access (all tiers, unlimited tool calls)
- `mcp_daily_quota`: retired. Every tier is `-1` (unlimited) so older clients that still read it stay uncapped
- `cloud_sync_enabled`: whole-file cloud backup (Pro + Team). The name is kept for older clients; it does not gate multi-device sync
- `vault_max_open_devices`: how many devices can have a personal vault open at once (Free = 1, Pro/Team = -1 unlimited). Team members get -1 server-side
- `personal_sync`: `on` or `paused`. Server kill switch for the personal sync engine; `paused` stops merging and publishing and keeps every edit on the device
- `shared_vaults`: multi-user shared vaults (Team only)
- `is_team_member`: team membership flag (UI/team vault logic only)
- Cached tier capabilities for offline mode

### Tier Enforcement & Downgrade Handling
- Entry creation limit enforcement (frontend + backend defense-in-depth)
- Credentials excluded from entry limit (only connection types count)
- Downgrade detection: periodic profile refresh (5-min interval + window focus)
- Tier change notification toast on plan downgrades/upgrades with app relaunch button
- Locked entry UX: lock icon + dimmed styling for entries beyond tier limit
- Oldest entries (by created_at) remain accessible; newer entries get locked
- Locked entries: restricted context menu (upgrade prompt + delete only)
- Double-click on locked entry shows upgrade prompt
- Active session cleanup: sessions on newly-locked entries auto-disconnect with notification
- Deleting entries frees up slots (locked entries become accessible)
- MCP gatekeeper: IPC socket server runs whenever `mcp_enabled` is true OR in local mode
  - Server starts/stops dynamically on auth state changes (sign in, sign out, tier change)
  - Socket file deleted on stop to prevent external connection attempts
  - Defense-in-depth: tier check on all IPC requests
- MCP tool calls are unlimited on every plan, including local mode (the old Free daily quota was removed)
- Personal vault device limit: on a downgrade to Free, extra devices with the vault open are displaced (soft lock) on their next heartbeat
- Team members: unlimited everything
- **30-day free trial**: CC-required trial for Pro and Team plans
  - One trial per user (Pro OR Team, not both); `has_used_trial` flag prevents re-trials
  - Team trials capped at 3 seats (checkout, seat adjustment, invite acceptance)
  - Sidebar: trial promotion card for eligible free users, countdown card for active trials
  - Auth screen: trial highlight banner above sign-in card
  - Settings Account tab: trial progress bar with days remaining and Subscribe Now CTA
  - UpgradeGate: "Start Free Trial" CTA when trial-eligible
  - Toast warnings at 7/3/1 days before trial ends
  - Trial conversion detection: success toast when trial converts to paid, warning when expired
  - Trial eligibility excludes team members and users already on Pro/Team tiers
  - App relaunch button on all plan change toasts for full state refresh
- **Contextual upgrade nudges**: Tasteful upgrade prompts at natural friction points
  - AI chat panel: full-panel split-layout gate showing Pro features when `aiChatEnabled` is false
  - Engine selector: "Pro" badge on Claude Code/Codex buttons; clicking opens pricing page
  - Entry tree: inline banner when connection limit reached with upgrade CTA
  - Context menu: "Upgrade to Access" on locked entries opens pricing page (replaces toast)
  - Vault Hub: split-card Team Vaults upgrade section for signed-in non-team members
  - Vault switcher: compact "Upgrade to Teams" row for non-team members
  - Pro vault lock dialog: split layout with benefits column alongside lock info
  - Settings AI tab: banner when AI features require Pro
  - All prompts hidden in local mode and for team members
  - Free → Pro CTAs open `/pricing`; Pro → Team CTAs open `/account`

---

## MCP Server

Standalone MCP server process exposes Conduit tools to AI agents (Claude Code, etc.).

### Tool Categories
- **Terminal**: execute commands, read pane (continuous scrollback — pass `lines` for tail size), send keys, create local shell with optional `working_directory`
  - `terminal_execute` runs inside the app against the session's live output stream: multi-line scripts, heredocs, comments, quotes, `!`, tabs, and non-ASCII text are sent encoded (as a bracketed paste when the shell supports it, otherwise as short acknowledged lines), so the shell parses the whole command before running it. Works with POSIX shells (bash, zsh, sh/dash, ash, ksh) and PowerShell (`shell` param; auto-detected for local shells)
  - Returns the exit code plus plain-text output in its own MCP text block (ANSI stripped, `\r` progress lines resolved); output without a trailing newline completes normally; very long output keeps the first and last parts with an omitted-lines note
  - One command at a time per session: parallel calls get `SESSION_BUSY`; a timed-out command keeps the session busy until it finishes or Ctrl+C is sent; full-screen programs block execution with `SCREEN_BUSY`
  - The user's terminal shows the agent's real command as if typed, never the wrapper or markers
  - `terminal_read_pane` reads a headless mirror of the user's screen (wrapped lines joined, full-screen programs rendered, `alternate_screen` flag)
  - `terminal_send_keys` supports `\r`, `\n`, `\t`, `\e`, `\xHH` escapes and an optional `wait_ms` that returns the program's response (for prompts, REPLs, TUIs)
  - Older Conduit apps without these IPC requests fall back to the previous polling behavior
- **RDP**: screenshot (returns native + image dims atomically), click, type, send key (press/down/up), mouse move, drag, scroll, resize (RDPEDISP), get dimensions
- **VNC**: screenshot (returns native dims atomically), click, type, send key (press/down/up), mouse move, drag, scroll, get dimensions
- **Web**: screenshot (returns viewport + image dims atomically), read content, navigate (with `wait_until` = `load`/`domcontentloaded`/`networkidle`), click, type, send key (press/down/up), mouse move, drag, scroll, get dimensions, click element (CSS selector), fill input (CSS selector), get interactive elements, execute JavaScript
- **Web Tab Management**: list tabs, create tab, close tab, switch tab, go back, go forward, reload — enables AI agents to manage multiple browser tabs per web session
- **Credentials**: list, create, read (with approval), delete, generate SSH key pair (`ssh_key_generate` — generates ed25519/RSA/ECDSA, stores encrypted in vault, returns only the public key + fingerprint)
- **Connections**: list (active and saved), open (SSH/RDP/VNC by manual host/port/credential params), open from vault entry (`connection_open_entry` — opens a saved ssh/rdp/vnc entry by its `entry_id`; resolves host, port, and credentials server-side from the entry, honoring stored RDP settings and SSH auth-method preference, so the agent never handles secrets), close (also drops cached coordinate scale factors so a reopen under the same id can't reuse stale scale)
- **Entry**: get metadata for any vault entry with optional notes (!!secret!! values auto-redacted), update entry notes, list entries (filter by `entry_type` / `folder_id` / `tags`), search entries (case-insensitive substring on name and host)
- **Document**: read, create, and update markdown document entries (!!secret!! values auto-redacted on read)
- **Sync conflicts**: `entry_info` and `credential_read` return `has_conflict: true` while the item has an unresolved multi-device sync conflict; the values returned are the provisional ones. MCP writes, imports and autofill-selector saves replace only the provisional value, so an open conflict stays open for the user
- **Tool errors**: a failed call returns `{"error", "code", "reason"}`. `code` is the app's error code (for example `VAULT_LOCKED`), and `reason` is `open_elsewhere` when another device took the vault over, so agents can tell a locked vault from one that is open elsewhere

### Safety & Controls
- **Local-socket isolation**: MCP server speaks over a Unix socket (or named pipe on Windows) created with `0o600` permissions — only the user that owns the Conduit process can connect. Nothing is exposed over the network.
- **Per-tool rate limiting**: Token-bucket limits sized per tool (e.g. screenshots 30/min, click/type 60/min, ssh_key_generate 6/min). Every registered tool has an explicit limit; nothing falls through to a generic default.
- **Tier-aware gatekeeper**: IPC server only accepts connections when `mcp_enabled` is true (or in local mode). Socket file is removed on stop; defense-in-depth tier check on every IPC request.
- **Credential approval**: `credential_read` still requires explicit user approval with a `purpose` reason — this is the one tool that reveals raw secrets, so the approval dialog is preserved.
- **Audit logging**: Every tool invocation (success, error, rate-limited) is logged with timing, args summary, and caller.
- **Secret redaction**: `!!secret!!…!!secret!!` blocks in entry notes and document content are redacted to `********` before being returned by `entry_info` / `document_read`.
- Standalone operation fallback (MCP server stays alive if the main app's connection blips — reconnects on next request)

### In-App Agent Instructions (Auto-Generated)
- Auto-generates `CLAUDE.md` in the Claude Code agent working directory (`{userData}/conduit[-dev]/agent/claude-code/`) with MCP setup instructions and tool reference
- Auto-generates `AGENTS.md` in the Codex, Grok, Cursor, Copilot, OpenCode, and OpenClaw agent directories, and `GEMINI.md` for Gemini CLI
- Scoped to Conduit-owned directories only — never written to the user's global `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, or a custom working directory, so Conduit instructions never leak into unrelated projects
- Managed sections written by builds up to v0.16.1 are stripped from the global files on launch (marker-based, user content preserved)
- Marker-based sections (`<!-- conduit-managed-start/end -->`) preserve user content in existing files
- Regenerated on every app launch with current version, socket path, and environment config
- Includes categorized tool reference built dynamically from the tool registry

---

## Import

### Vault Export/Import (.conduit-export)
- Export full vault or individual folders to encrypted `.conduit-export` files
- User-provided passphrase encryption (PBKDF2-SHA256, 600k iterations, AES-256-GCM)
- Domain-separated key derivation (`conduit-export-v1`) to prevent key reuse
- Decrypt and preview before importing (shows source vault, folder tree, entry type counts)
- Import into vault root or specific target folder
- Fresh UUID generation for all imported entries/folders (safe to re-import)
- Credential reference remapping for included credentials, clearing for external refs
- Works across personal and team vaults (team sync auto-picks up imported entries)
- Topological folder creation order (parents before children)
- Export from vault switcher menu or folder context menu
- Import from vault switcher menu

### Devolutions Remote Desktop Manager (.rdm)
- File picker for .rdm (XML) export files
- Automatic credential decryption (per-type built-in keys, no passphrase needed)
- Supported types: SSH, RDP, VNC (AppleRemoteDesktop), Web, Group (folder + credential), Credential (PasswordList, ApiKey, simple), DataEntry/SecureNote (→ document), Document (local file read)
- Preview step: grouped by folder, status badges (ready, decrypt-failed, unsupported, duplicate)
- **Duplicate detection**: Entries matching by name + type + host are flagged as duplicates during preview, with "Overwrite All" or "Skip All" strategy prompt before import
- Batch import with tier-limit enforcement (partial import)
- Folder structure recreation
- Group credential extraction
- CredentialConnectionID reference resolution
- Credential PasswordList flattening (one entry per list item, prefixed names)
- Secure note decryption and import as markdown document entries
- Document file import (reads local file content when referenced file exists)
- Import result summary (imported, skipped, overwritten, errors)
- Export import log to .log file

---

## Team Management (Website)

Team administration is handled on conduitdesktop.com. The desktop app is team-aware but defers management to the website.

### Team Lifecycle
- **Creation**: Team setup form with name, slug (auto-generated, editable), seat count (1-100), billing interval (monthly/annual)
- **Stripe checkout**: Per-seat subscription (pricing managed in production Supabase `tiers` table — run `SELECT name, price_monthly, price_annual FROM tiers ORDER BY sort_order;` for current values)
- **Webhook provisioning**: On successful checkout, webhook creates the team, adds owner as admin, sets tier to Team
- **Pro upgrade path**: Users upgrading from Pro receive prorated credit; old subscription auto-canceled
- **Dissolution**: Canceling team subscription downgrades all members to Free, removes memberships

### Team Dashboard (`/account/team`)
- Team name, slug, role badge (Admin/Member)
- Seat usage display (members + pending invitations vs. max seats)
- Inline seat adjustment with prorated cost preview
- Member list with avatars, roles, and admin controls (role toggle, remove)
- Pending invitations with revoke capability
- Billing management link (Stripe Customer Portal)
- "Team created!" banner on successful checkout redirect

### Invitations
- Email-based invitation system with admin/member role selection
- 7-day expiring tokens (auto-generated by DB)
- Invitation emails sent via Resend with branded dark-theme template
- Acceptance flow: validates token, checks expiration, prevents multi-team membership
- On accept: adds member, sets tier to Team, increments Stripe seat quantity
- Decline and admin revoke supported
- Pending invitations shown to recipients on their account page with accept/decline

### Seat Management
- Admins can adjust seat count (1-100) from the dashboard
- Cannot reduce below current members + pending invitations
- Stripe subscription quantity updated with prorations
- "Add Seats" button prominently shown when at capacity
- Inline "Add a Seat" option in invite form when seats exhausted

### Member Management
- Role changes (admin ↔ member) with last-admin protection
- Member removal downgrades removed user to Free tier, decrements Stripe quantity
- Owner cannot be removed (protected in API)
- Self-removal not allowed (prevents accidental team abandonment)

### Owner Self-Add (`/api/team/add-self`)
- Idempotent endpoint for team owner to ensure they're in `team_members`
- Repair mechanism if webhook failed to insert owner
- Sets profile tier and primary_team_id

### Constraints
- One team per user (enforced on invite accept and team creation)
- Only team admins can invite, revoke, change roles, adjust seats, manage billing
- Team owner is immutable — dissolution requires subscription cancellation
- Email-tied invitations must match authenticated user's email

---

## Authentication & Accounts

- Browser-based authentication via conduitdesktop.com
  - Sign-in and registration open system browser (no in-app auth forms)
  - Deep link callback (`conduit://auth/callback`) receives tokens after browser auth
  - MFA verification and enrollment handled on website
  - Interstitial "Opening Conduit..." page with fallback manual button
- Email confirmation flow via website
- Session management with refresh tokens
- Deep linking for OAuth callbacks (conduit:// protocol)
- Sign-out with session cleanup
- User profile retrieval
- Token usage metrics from backend
- Auth modes: authenticated, cached (offline), local (standalone)
- Background re-authentication every 60s in cached mode
- TOTP multi-factor authentication (MFA) via website
  - MFA enrollment on website account security page
  - TOTP verification on website during login flow
  - AAL2 session restore skips MFA prompt on app restart
  - Local mode unaffected by MFA requirements
- Environment configuration (preview/production)
  - `CONDUIT_ENV` flag selects Supabase branch, website URL, and local data directory
  - Dev defaults to preview, builds default to production
  - Separate local storage paths per environment: `conduit/` (production) vs `conduit-dev/` (preview)
  - Independent vault, settings, auth session, chat DB, and IPC socket per environment
  - Dev and production instances can run simultaneously without conflicts

---

## Settings & Preferences

### Window
- Remember window size and position across launches (persisted in ui-state.json)
- Maximized state restored on relaunch
- Position validated against connected displays (falls back to centered if saved position is offscreen)

### Appearance
- Theme: dark, light, system
- Color scheme selection: 6 universal schemes (Ocean, Ember, Forest, Amethyst, Rose, Midnight)
- **Platform themes**: Full platform-native look & feel with 4 selectable themes:
  - **Default** — Conduit Classic (current styling)
  - **macOS Tahoe** — Liquid glass translucency with backdrop blur on sidebar/dialogs/menus, large rounded corners, SF Pro font, Phosphor icons (SF Symbols style), thin auto-hide scrollbars
  - **Windows 11** — Fluent Design with Mica-style surfaces, underline tab indicators, compact density, Segoe UI font, Fluent UI icons, WinUI 3 controls
  - **Ubuntu** — GNOME/Libadwaita design with bold headerbar, flat surfaces with strong borders, pill-shaped buttons, Ubuntu font, bold-stroke icons
- **Native color schemes** per platform (only shown when that theme is active):
  - macOS: System Blue, Graphite
  - Windows: Windows Blue, Sun Valley
  - Ubuntu: Yaru Orange, GNOME Blue
- **3-axis theming**: Platform Theme × Color Scheme × Dark/Light — all axes compose orthogonally
- **Themed icon system**: Each platform theme swaps the entire icon set (127 icons) via lazy-loaded packs with code splitting
- UI scale slider (75%-150%)

### Behavior
- Default shell (bash, zsh, fish, etc.)
- Sidebar mode: pinned or auto-collapse
- Default AI engine: icon grid for Claude Code, Codex, Grok Build, Cursor Agent, OpenClaw, Gemini CLI, GitHub Copilot, and OpenCode
- Default working directory for agent sessions
- Engine status indicators (available/unavailable with auth instructions)

### Mobile
- **Mobile settings tab**: QR code for downloading Conduit on iPhone & iPad from the App Store
- Vault sync info: keep the vault file in iCloud Drive, OneDrive or Dropbox to use it on every device; Conduit merges the changes. On Free a vault can be open on one device at a time

### Security
- Quick Unlock toggle (macOS)
- "Lock the vault when idle" (off by default; see Auto-Lock)

### Sync
- Plan line (marks the dev override), paused notice, Sync now, devices list and review tools (see Multi-Device Sync). No on/off switch

### Vault
- Recent vaults tracking (last 10)
- Last opened vault persistence
- Open from recent list
- Remove individual vaults from recents (right-click context menu) with "Copy Path" option
- Clear all recent vaults via "Clear All" link in VaultHub and VaultSelector headers

---

## UI & UX

### Splash Screen
- Native HTML splash screen shown immediately on launch before React mounts
- Branded loading state eliminates blank white flash during app initialization
- Fades out (400ms transition) once React is ready

### Onboarding
- Tier-aware onboarding wizard for first-time authenticated users
- Free tier: 5 steps (Welcome, Vault, Connections, Organization, MCP Tools)
- Pro tier: 7 steps (adds AI Assistant, Multi-Device Sync)
- Teams tier: 10 steps (adds Team Vaults, Permissions, Audit Trail)
- Full-screen wizard with GIF placeholder areas, dot indicators, prev/next navigation
- Skip option available at any point
- Existing users see onboarding already completed (settings migration)
- Replayable via "Getting Started" button in Help dialog

### Sidebar
- Connection tree (hierarchical folders + entries)
- Filter by name/type
- Favorites filter toggle with persisted state
- Favorites-only view groups favorited entries by folder path
- **Search results grouped by folder**: Search results display entries organized by their folder path (e.g., "Servers / Production"), making it easy to distinguish entries with the same name in different folders
- Search field shows a clear (✕) button once text is entered; Escape also clears it
- Context menu: open, edit, duplicate, copy host, move, delete
- Inline folder creation

### Tab Bar
- Multi-session tabs
- Close tab (Cmd+W)
- Tab navigation: next (Cmd+Tab), previous (Cmd+Shift+Tab)
- Active tab highlighting

### Split-View Pane Layout
- **Drag-to-split**: Drag a tab from the tab bar to any edge of the content area to split into side-by-side or stacked panes
- **Drop zones**: Five drop targets (center, left, right, top, bottom) with theme-aware visual feedback (`conduit-500` accent highlights)
- **Binary tree layout**: Panes organized as a binary tree (branch = split, leaf = pane) via `react-resizable-panels`
- **Per-pane tab bars**: Each pane has its own tab bar with close, reorder, and context menu actions
- **Tab reordering**: Drag tabs within a pane to reorder, or across panes to move sessions
- **Context menu split**: Right-click a tab → "Split Right" or "Split Down" to move it to a new split
- **Pane auto-collapse**: Closing the last tab in a pane collapses it, promoting the sibling to fill the space
- **Resize handles**: Draggable dividers between panes with hover-highlight feedback
- **Restore to full screen**: Closing all split panes returns to single-pane layout
- **Focused pane tracking**: Click inside a pane to set focus; focused pane has a top accent border
- **Session preservation**: Terminal and command sessions (xterm.js instances) preserved across split/collapse via global registries — no loss of scrollback or history
- **RDP resize**: Immediate CSS scaling on split, followed by debounced native RDPEDISP resize with HiDPI/Retina support
- **Terminal resize**: FitAddon recomputes rows/cols on container resize; backend notified via `terminal_resize`
- **Layout-changed event**: All session types listen for `conduit:layout-changed` to adapt to pane size changes
- **Native webview handling**: Webviews hidden during drag operations to prevent overlay conflicts with drop zones
- **New session from pane**: "+" button in pane tab bar to create a new local shell session directly in that pane

### Keyboard Shortcuts
- Cmd+E / Ctrl+E: New entry
- Cmd+Shift+N / Ctrl+Shift+N: New folder
- Cmd+O / Ctrl+O: Open vault
- Cmd+Shift+L / Ctrl+Shift+L: Lock vault
- Cmd+S / Ctrl+S: Save vault
- Cmd+, / Ctrl+,: Settings
- Cmd+G / Ctrl+G: Password generator
- F1: Help
- Cmd+Shift+Space / Ctrl+Shift+Space: Credential Picker (global, works when app is in tray)
- Cmd+W / Ctrl+W: Close tab
- Cmd+Tab / Ctrl+Tab: Next tab
- Cmd+Shift+Tab / Ctrl+Shift+Tab: Previous tab

### Dialogs
- Vault unlock
- Cloud restore
- Vault selector
- Password generator
- Settings (tabbed)
- What's New (post-update release notes carousel with in-app link support)
- About
- Help
- Import (RDM)
- MCP approval

### Notifications & Indicators
- Cloud backup status (vault); the dashboard's Cloud Backup and Local Backup rows stay current whether or not the sidebar or Settings > Backup is open
- Personal vault sync status in the sidebar, with "N to review" when conflicts are queued
- Sync banners above the main area (soft lock, side files paused, file missing, different vault or newer format, held changes from an older app, copy to review, changes need review)
- Offline mode banner
- Auto-update notification
- **Unified toast notification system**: Global `toast.success()`, `toast.error()`, `toast.warning()`, `toast.info()` API
  - Configurable messages with persistent or auto-dismiss (5s default) behavior
  - Action buttons (primary/default variants) with custom click handlers
  - Queue management: max 5 visible toasts, oldest non-persistent auto-dismissed on overflow
  - Smooth toast-in/toast-out animations, works from anywhere in the app
  - **Native overlay rendering**: Notifications float above native RDP, VNC, and web sessions in a transparent overlay window
    - Always visible even when remote sessions are active (native views no longer obscure toasts)
    - Click-through when not hovered — mouse events pass to the app below
    - Interactive on hover for dismissing or clicking action buttons
    - Theme-synced with the main window (dark/light)
    - Auto-hides when the app is minimized or unfocused
- Connection error overlay: friendly error messages for SSH, VNC, web, and terminal failures with reconnect/close actions
- Error tooltip on tab status dot (hover red dot to see error message)
- Mid-session disconnect detection: SSH drops, VNC server closes, and web load failures update UI in real-time
- Local shell auto-close: clean exit (code 0) removes tab; non-zero shows error overlay

### Entry Dashboard
- Detail view when selecting an entry in the sidebar (host, username, password, domain, tags, notes)
- Copy buttons for username, password, and host
- Open in external app: launch connections in system default applications
  - Web → system browser
  - SSH → default SSH client (Terminal.app on macOS)
  - VNC → default VNC viewer (Screen Sharing on macOS)
  - RDP → generates temp `.rdp` file with connection settings, opens in default RDP client
- Quick edit button to open entry edit dialog directly from dashboard
- Favorite toggle in header
- Two-column layout: details on left, markdown notes on right (when notes exist)
- **Selectable text**: All detail values (host, username, revealed password) and markdown notes are highlightable and copyable via text selection
- **Secret copy button**: `!!secret!!` values in markdown notes show a copy button when revealed, in addition to being selectable
- **View Info tab**: Right-click any entry → "View Info" to open the dashboard as a persistent tab alongside active sessions
  - Access notes, credentials, TOTP codes, and connection details even while sessions are open
  - Also available from the session tab right-click menu ("View Info")
  - Deduplicates: only one info tab per entry, re-selecting activates the existing tab
  - "Open Session" button in the info tab creates a real session as a separate tab

### Context Menus
- Theme-aware custom context menus
- SVG icon support
- Keyboard shortcut hints
- Smart screen-bounds positioning
- **Linked credential support in context menus**: Copy Username, Copy Password, and Auto-type work with linked credentials — entries using a credential reference are treated the same as entries with inline credentials
- **Auto-type credentials**: Right-click entry → "Auto-type" submenu to type credentials
  - Type Username, Type Password, or **Username → Tab → Password** (combined sequence)
  - Combined mode types username, sends Tab keystroke, then types password in one action
  - **In-session typing**: Types into the active Conduit session (RDP, SSH, VNC, Web, Local Shell) with 2-second delay
  - **Global typing**: When no active session, types into any focused external application (browser, terminal, etc.) with 3-second delay
  - OS-level keystroke simulation: AppleScript on macOS, Win32 SendInput via koffi FFI on Windows (Unicode KEYEVENTF_UNICODE for full character support regardless of keyboard layout)
  - macOS Accessibility permission: auto-prompts and adds Conduit to the Accessibility list on first use; opens System Settings as fallback
  - Always available in context menu (no longer requires an active session)

---

## Menus

### File
- New Vault, Open Vault, New Entry, New Folder
- Import > From Remote Desktop Manager...
- Lock Vault, Rename Vault, Sign Out, Settings, Close/Quit

### Edit
- Undo, Redo, Cut, Copy, Paste, Select All

### View
- Reload, Force Reload, Dev Tools, Zoom, Fullscreen

### Tools
- Password Generator
- SSH Key Generator

### Window
- Minimize, Zoom, Front (macOS), Close (Windows)

### Help
- Conduit Help
- Submit a Bug — pre-filled system info, optional log file attachment, up to 5 screenshot attachments (5 MB each, png/jpg/gif/webp), sent to Supabase
- Submit Feedback — lightweight suggestion/feature request form

### System Tray
- **Close to tray/dock**: Clicking the close button (red X on macOS, X on Windows) hides the window instead of quitting — the app stays running in the system tray (Windows) or dock (macOS). Vault is automatically locked and all sessions closed on hide. Reopening from the dock, tray, or a second-instance launch requires vault re-unlock. Cmd+Q / tray Quit fully exits the app.
- Show Conduit, Credential Picker, Quit
- **Credential Picker**: Tray popup window for quick credential access without opening the full app
  - Global shortcut: Cmd/Ctrl+Shift+Space (also available from tray context menu)
  - Search and filter credentials with keyboard navigation (arrow keys + Enter)
  - Detail view with copy buttons for username, password, TOTP code, domain, and private key
  - TOTP countdown ring with auto-refresh and visual low-time warning
  - Vault unlock support: password prompt (personal vault) or auto-unlock (team vault)
  - Works independently of main window (app can be in tray-only mode)
  - Frameless, always-on-top popup positioned near tray icon
  - Closes on blur (click outside), Escape key, or X button

---

## Auto-Update
- electron-updater integration
- Background update checks
- Non-blocking update notification in UI
- **Real-time download progress**: Progress bar with percentage, transferred/total bytes, and speed during update download; shown in both main window and overlay notification
- Silent install on next restart
- Graceful install failure fallback: if `quitAndInstall()` fails (e.g., ad-hoc signed builds), auto-opens the website download page and transitions UI to error state with "Download from Website" button
- **What's New in-app links**: Release note highlights support `[label](conduit://settings/<tab>)` syntax to link directly to settings tabs (e.g., promote mobile app download from release notes)

---

## Password Generator
- Configurable length and character sets
- Accessible from Tools menu (Cmd+G) or credential forms

---

## SSH Key Generator
- Key types: Ed25519 (recommended), RSA (2048/4096 bits), ECDSA (P-256/P-384/P-521)
- Optional passphrase encryption (AES-256-CBC) with confirmation
- Optional comment field for key identification
- OpenSSH-format public key output (ready for `authorized_keys`)
- PEM-format private key output
- SHA-256 fingerprint display
- Copy public/private key to clipboard
- "Use Private Key" to insert directly into credential forms
- Inline generate button next to Private Key fields (entry dialogs + credential manager)
- Standalone mode via app menu

---

## macOS Local Network Permission
macOS 15+ gates LAN access behind a privacy permission that is only evaluated when the app touches the local network, and the consent alert is only ever offered once per app identity. Without an early request, a fresh install or an update can leave the app silently unable to reach any LAN device.

- **Requested on every launch**: connects a UDP socket to each link-local IPv6 address and each LAN IPv4 address at startup (Apple TN3179's documented way to raise the alert), so the permission decision happens during startup rather than mid-connection
- **Re-asked during the settle window**: if the first probe is still denied, the same trigger runs again every 3 seconds for up to 60 seconds so an alert that fired before the window was frontmost is not missed
- **Denial detection**: sends a Bonjour query to the mDNS multicast group; macOS blocks that send when the permission is missing, which distinguishes a blocked app from an offline host (both otherwise surface as `EHOSTUNREACH`)
- **Settle window**: keeps re-probing for 60 seconds so an alert the user is still reading is not reported as a denial
- **Persistent toast on denial**: explains that macOS is blocking LAN access, names the app that must be toggled (Conduit when packaged, Conduit Dev for `npm run dev:electron`), with an "Open Settings" button that opens Privacy & Security (macOS exposes no URL anchor for the Local Network sub-pane)
- **Connection error screens**: show the same guidance when a session fails while the permission is denied, instead of the misleading "check network connectivity" message
- **Unique identity per build**: packaged Conduit and the npm Electron.app used in dev each get their own bundle id and a rewritten Mach-O `LC_UUID`, so they do not collide with stock Electron or with each other. Dev stamping runs from `postinstall` / `npm run stamp:electron` and signs the main executable with an Apple Development identity when one is in the keychain
- Interface names are read from the system, never hardcoded; tunnel interfaces (VPN/utun) are excluded from the "is there a LAN" check
- No-ops entirely on Windows and Linux
