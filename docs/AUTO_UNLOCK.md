# Startup vault and automatic unlock

Status: built on `advenimus/auto-unlock`, 2026-09-29 (spec revised the same day after a code review, section 11). Owner decisions 10.6 to 10.9 follow the recommendations: the password is sealed, MCP waits for a person, a toast follows each automatic open, and the other fuses ship while `RunAsNode` stays on. Section 12 lists where the build differs from this spec.

**Owner request.** "A way to store auth for vaults in system so that you can set a default vault and just open the app without the need for auth or unlock. A warning should be shown obviously. Think about good UI UX in doing this."

**Scope.** Desktop only (macOS, Windows, Linux), personal and team vaults, every plan. iOS is out of scope: it already re-opens the vault with Face ID (`IOS/ConduitApp.swift:24-39`, cited in `docs/MULTI_DEVICE_SYNC.md` 6.3).

**Path roots.** Paths are relative to this repository. `IOS` is the conduit-iOS-private repository.

**Evidence tags.**
- **[V]** verified by reading the code at b072690, or by running a command on this Mac.
- **[A]** assumed. Every [A] item is listed again in section 9 and must be tested.

---

## 1. Overview

### 1.1 The two choices

Both are per computer. Neither syncs, and neither is stored in the vault file.

| Choice | Where | What it does |
|---|---|---|
| **Open at startup** | Settings > General (new "Startup" section); Vault Hub and vault menu right-click | Picks what Conduit shows when it starts: the Vault Hub, one personal vault, or one team vault. A personal vault goes straight to its unlock prompt (Touch ID starts by itself when Quick Unlock is on). |
| **Unlock automatically at startup** | Checkbox in the unlock dialog; Settings > Security (new "Automatic Unlock" section) | The startup vault opens with no password. Conduit keeps the master password sealed by the operating system's secret store. Turning it on needs the master password or Touch ID at that moment, and a warning must be accepted first. |

### 1.2 Decisions in brief

1. **Automatic unlock is tied to the startup vault.** At most one vault per computer has a saved unlock: the one that opens at startup. Choosing another startup vault forgets the old saved unlock. Reason: a saved unlock is never used anywhere else (rule 3), so a second one would only add exposure. This refines the "per personal vault" direction.
2. **What is sealed is the master password**, with Electron `safeStorage`, exactly like Quick Unlock does today (section 3.1). Sealing only the vault key would need a key-based open path, backups and chat store. The password reaches further than the key (backups, other devices), so this is an owner decision (section 10, item 6).
3. **Automatic unlock runs only when Conduit starts**, or when its window opens again after a close that locked a vault which had opened automatically and was not locked since. After a lock (the Lock command, the idle lock, the screen lock), the vault asks for the password or Touch ID until Conduit starts again, even if the window is then closed and reopened. Section 4.6 justifies this.
4. **It never takes over and never skips a gate.** Every check in the open path still runs and shows its normal dialog: open on another device, device cap, not the owner, sign-in required, update required, damaged working copy, password changed elsewhere.
5. **One automatic attempt per start.** If the saved password is wrong or was changed elsewhere, Conduit forgets it at once, shows the normal prompt with a plain note, and offers to save the new one. It never retries by itself.
6. **Escape hatch:** hold Shift (or Option on a Mac) while Conduit starts, or click "Go to Vault Hub" on the opening screen, or start it with `--no-startup-vault`. Conduit then shows the Vault Hub for that start only. Only a key held in the first moments counts, so typing on the sign-in screen never skips (4.5).
7. **Refused where the secret store is weak:** when `safeStorage` is not available, and on Linux when the backend is `basic_text` or `unknown`. Checked again at every seal, not only when turned on.
8. **Runs only after sign-in settles, and only for the account that turned it on.** Main checks the signed-in user id against the one sealed with the password. Any change of account forgets the saved unlock.
9. **All plans.** It is a local convenience and costs the server nothing.
10. **macOS needs fuse hardening first** (section 6.0). Today any program running as the user can start Conduit's own binary with a debugger flag and read the secret store with no prompt. Until the fuses ship, the warning and threat table treat macOS like the other systems.
11. **MCP waits for a person (recommended, owner decision 10.7).** After an automatic unlock, MCP calls get the locked error until the first real key press or click in the Conduit window. Without this, any program on the computer can launch Conduit and read every password over the MCP socket.

---

## 2. User-facing behavior and every UI string

Rule for every screen: the layout stays as it is today. Lines marked `+` in the mockups are the only additions. Lines without `+` exist today.

### 2.1 Unlock dialog (unlock mode)

Today: title "Unlock Vault", file name, status line, "Master Password" field, "Quick Unlock" button, error callout (`src/components/vault/UnlockDialog.tsx:233-320`) [V]. The create mode already uses the same `Checkbox` with a description (`UnlockDialog.tsx:304-315`) [V], so the new checkbox follows that pattern.

```
+----------------------------------------------+
| [lock] Unlock Vault                          |
|                                              |
| Work.conduit                                 |
| Enter your master password to access         |
| credentials                                  |
|                                              |
| Master Password                              |
| [••••••••••••••••••                  ] [eye] |
|                                              |
| [ (fingerprint) Quick Unlock               ] |   (only when Quick Unlock is on)
|                                              |
|+[ ] Unlock automatically at startup          |
|+    Opens this vault when Conduit starts,    |
|+    without the password.                    |
|                                              |
|                         [Cancel]  [Unlock]  |
+----------------------------------------------+
```

- Shown when: unlock mode (not create), a personal vault, the secret store is usable (section 3.2), this vault has no saved unlock yet, not in take-over mode ("Unlock to use this vault here..." status line), and **no Touch ID prompt is running**.
- Quick Unlock vaults: Touch ID starts by itself on mount and success closes the dialog at once (`UnlockDialog.tsx:77-106`) [V], so there is no moment to tick a box. The checkbox appears only after that Touch ID prompt is cancelled or fails. It then applies to whichever unlock the user starts: the Unlock button or a tap on Quick Unlock. The other way in for these users is Settings > Security, which has its own Touch ID proof.
- Unchecked by default, every time.
- When checked and the unlock succeeds, the dialog switches to the warning (2.2) instead of closing. This is the same in-place swap the Touch ID setup prompt uses (`UnlockDialog.tsx:221-228`) [V]. The Touch ID setup offer is skipped for this unlock.
- The vault is already unlocked at that point. Cancel on the warning keeps it unlocked and saves nothing.

**After a lock, for a vault with a saved unlock.** The checkbox is hidden (a saved unlock exists), so the status line explains why a password is asked: "Automatic unlock runs when Conduit starts. Enter your master password or use Quick Unlock." ("or use Quick Unlock" only when Quick Unlock is on.) Without this, people who have not typed the password in weeks think the feature broke.

**Stale state** (the saved password did not open the vault at startup; section 4.4). The saved unlock is already forgotten when this shows.

```
+----------------------------------------------+
| [lock] Unlock Vault                          |
|                                              |
| Work.conduit                                 |
|+[!] Conduit couldn't open Work automatically.|
|+    The master password may have changed on  |
|+    another device. Enter it to open the     |
|+    vault.                                   |
|                                              |
| Master Password                              |
| [                                    ] [eye] |
|                                              |
|+[x] Keep unlocking automatically at startup  |
|+    Saves the password you enter now.        |
|                                              |
|                         [Cancel]  [Unlock]  |
+----------------------------------------------+
```

- The note is a `Callout tone="warning"` in place of the status line.
- The checkbox starts checked. On success: checked seals the new password with no second warning (it was accepted before) and shows the toast "Saved unlock updated". Unchecked shows "Automatic unlock is off".
- Cancel closes the dialog and shows the Hub with the toast in 2.8 row "Startup open cancelled", which carries a "Stop Opening at Startup" action. The next start shows the plain unlock prompt, because the saved unlock is gone.

**Unreadable state** (the secret store could not decrypt the saved entry; section 3.3). Here the entry is kept: the fault may be the store, not the password.

```
|+[!] Conduit couldn't read the saved unlock   |
|+    from the system keychain. Enter your     |
|+    master password.  [Turn Off Automatic    |
|+    Unlock]                                  |
```

- "system keychain" reads "Windows credential store" on Windows and "system keyring" on Linux (one helper, `secretStoreName()`).
- The same checkbox as the stale state shows, checked.
- "Turn Off Automatic Unlock" is a link button inside the callout.

**Retryable file problem at startup** (`VAULT_FILE_UNREADABLE`, for example the cloud drive is still downloading; `src/components/sync/UnlockErrorView.tsx:11-22`) [V]: the existing error line shows, plus a `+ [Try Again]` link button that repeats the automatic attempt. It works only while the startup attempt is still open (section 4.3).

**When the dialog is the fallback of an automatic attempt** (a gate dialog, the stale or unreadable state, or attempt kind `"saved"`):
- Touch ID does **not** start by itself. The mount effect (`UnlockDialog.tsx:77-89`) [V] also checks that no fallback is showing. The Quick Unlock button stays for a manual tap. Reason: an unasked Touch ID sheet on top of a take-over or not-owner dialog is confusing, and it would be a second attempt in one start.
- Cancel on any gate dialog (take-over, not owner, sign-in required, update required, damaged copy, password changed elsewhere) closes the **whole** unlock dialog and shows the Hub with the "Startup open cancelled" toast. Today `handleErrorCancel` only clears `openError`, which drops back to the password form (`UnlockDialog.tsx:147-151`) [V]; that stays the behavior for typed-password and Touch ID attempts.

### 2.2 Warning dialog (new: `AutoUnlockWarningDialog`)

Opened from the unlock dialog checkbox, from the Security switch and from the stale/unreadable paths when the user turns it back on from Settings. Built from `Dialog` (tone warning, width 420), `Callout`, `PasswordInput`, `Button`.

From the unlock dialog (the password was just proven):

```
+--------------------------------------------------+
| [alert] Unlock Work automatically?               |
|                                                  |
| Conduit will keep the master password for        |
| Work.conduit in the system keychain and open     |
| this vault when Conduit starts, without asking.  |
|                                                  |
| [!] Anyone who can use this computer while you   |
|     are logged in to it can open this vault and  |
|     see its passwords. AI agents and other       |
|     programs on this computer can use it as soon |
|     as Conduit starts. Only turn this on for a   |
|     computer that only you use and that locks    |
|     with a password.                             |
|                                                  |
| Conduit will open Work instead of the Vault Hub. |   (replacement line, always)
|                                                  |
| Safer: open Work at startup and unlock it with   |   (macOS with Touch ID only)
| Touch ID.  [Use Touch ID Instead]                |
|                                                  |
|                         [Cancel]  [Turn On]      |
+--------------------------------------------------+
```

From Settings > Security (proof needed now), the body adds a field above the footer:

```
| Enter your master password to turn this on.      |
| Master Password                                  |
| [                                        ] [eye] |
| [ (fingerprint) Use Touch ID ]                   |   (only when Quick Unlock is on for this vault)
```

Strings:
- Title: "Unlock {name} automatically?" where `{name}` is the file name without `.conduit`.
- Body: "Conduit will keep the master password for {file} in the {store} and open this vault when Conduit starts, without asking."
- Warning (the owner's draft, second sentence widened after review): "Anyone who can use this computer while you are logged in to it can open this vault and see its passwords. AI agents and other programs on this computer can use it as soon as Conduit starts. Only turn this on for a computer that only you use and that locks with a password."
- Replacement line, one of, by the current startup choice:
  - Vault Hub: "Conduit will open {name} instead of the Vault Hub."
  - Last team vault used: "Conduit will open {name} instead of your last team vault."
  - Another personal vault: "Conduit will open {name} instead of {otherFile}."
  - A team vault: "Conduit will open {name} instead of the team vault {teamName}."
  - Already this vault: the line is left out.
- Touch ID line: "Safer: open {name} at startup and unlock it with Touch ID." Button: "Use Touch ID Instead". It sets the startup vault to this vault, turns on Quick Unlock for it when it is off, seals nothing, and closes with the toast "{name} opens at startup" / "Touch ID unlocks it."
- Password proof hint: "Enter your master password to turn this on." Wrong password: `Callout tone="danger"` "That password didn't work."
- Buttons: "Cancel", "Turn On" (primary). "Turn On" is disabled until the password field has text when a password is required.
- Escape and the scrim act as Cancel.
- Success toast: `toast.success("Automatic unlock is on", "{name} opens when Conduit starts. Hold Shift while Conduit starts to skip it.")` On macOS the message says "Hold Shift or Option".

### 2.3 Opening screen at startup

Today the team auto-connect shows `FullScreenSpinner` "Connecting to team vault..." (`src/App.tsx:114-123, 999-1001`) [V]. `FullScreenSpinner` is a plain div with no role and no focus [V]. The personal startup reuses it with one added button:

```
                 (spinner)
              Opening Work...
+           [ Go to Vault Hub ]
```

- Text: "Opening {name}..." for a personal vault, "Connecting to team vault..." (unchanged) for a team vault. The text gets `role="status"` so screen readers announce it.
- "Go to Vault Hub" (secondary `Button`) gets focus when it appears, so Enter, Space and Escape all work from the keyboard. It cancels the open and shows the Hub.
- It shows for a personal automatic unlock, and for a team vault chosen as the startup vault in Settings (now a deliberate choice, and a hung connection needs a way out). The "Last team vault used" path keeps today's screen with no button.
- The toast "Startup vault skipped" / "Conduit opened the Vault Hub. {name} opens next time." confirms a cancel or an escape-hatch skip.

### 2.4 Settings > General: new "Startup" section

Today the tab says only "No general settings available." (`src/components/settings/tabs/GeneralTab.tsx:1-9`) [V]. That line goes. The new section uses `SectionHeader`, `SettingsRow` and `Select`:

```
+ Startup
+ ------------------------------------------------------------
+ Open at startup
+ [ Work (personal)                                        v ]
+ What Conduit shows when it starts. Hold [Shift] while it
+ starts to go to the Vault Hub once.
+
+ (lockOpen) Unlocks automatically on this computer.
+ Change in Security.
```

Select options, in order:
1. "Last team vault used" (value `null`; team members only). Hint when selected: "Conduit reconnects to the team vault you used last, like today. Otherwise it shows the Vault Hub." (Renamed from "Automatic" so it is never confused with automatic unlock.)
2. "Vault Hub" (value `{kind:'hub'}`; for users who are not team members this option also stands for `null`).
3. Group "Personal vaults": each recent vault as "{name}". When two share a name: "{name} ({parent folder})".
4. Group "Team vaults" (signed in team members only): each team vault as "{name}".

Behavior:
- The Select acts at once through `startup_vault_set` (like the Quick Unlock switch, `src/components/settings/tabs/SecurityTab.tsx:28-42`) [V]. It is not part of Save. The dialog's Save merges only changed keys (`SettingsDialog.tsx` via `mergeChangedSettings`) [V per fact sheet], so Save never overwrites it.
- Choosing another vault while a saved unlock exists opens a `ConfirmDialog`: title "Turn off automatic unlock?", body "{old} unlocks automatically at startup. Choosing another startup vault turns that off and forgets the saved password.", buttons "Cancel" / "Continue". Then the toast "Automatic unlock is off" / "{old} asks for the master password again."
- The Kbd line reads "Hold [Shift] or [Option]" on macOS.
- The `lockOpen` line shows only when the startup vault has a saved unlock. "Security" is a link that switches the Settings tab.
- A team vault as the startup vault gets the hint "Team vaults open without a password on this computer."

### 2.5 Settings > Security: new "Automatic Unlock" section

Placed between "Quick Unlock" and "Auto-lock" (`SecurityTab.tsx:49-112`) [V]. It is not macOS-only. It reuses the `Card` + `Switch` layout of the Quick Unlock card and the `NoticeCard` for states that cannot be changed. `NoticeCard` always draws a fingerprint icon today (`SecurityTab.tsx:117-123`) [V]; it gains an `icon` prop (default fingerprint) and this section passes `LockOpenIcon`.

```
  Quick Unlock                                   (unchanged, macOS)
  [Card: fingerprint | Quick Unlock | switch]

+ Automatic Unlock
+ +--------------------------------------------------------+
+ | (lockOpen) Unlock automatically at startup    [switch] |
+ |            Open Work without the master password       |
+ |            when Conduit starts                         |
+ +--------------------------------------------------------+
+ [!] Anyone who can use this computer while you are logged
+     in can open this vault. Locking still asks for the
+     password, but closing or quitting Conduit and opening
+     it again does not.
+ Your master password is kept in the system keychain on
+ this computer.

  Auto-lock                                      (unchanged)
  [Lock the vault when idle  v]
```

States and strings:

| State | Shown |
|---|---|
| A team vault is active | NoticeCard: "Automatic unlock is for personal vaults. Team vaults already open without a password on this computer." When a personal vault has a saved unlock, a second line: "{name} unlocks automatically on this computer." with the link "Turn Off". |
| Secret store missing | NoticeCard: "Automatic unlock needs the system keychain, and it isn't available on this computer." (Windows: "system credential store"; Linux: see next row) |
| Linux `basic_text` or `unknown` | NoticeCard: "Automatic unlock needs a system keyring, such as GNOME Keyring or KWallet. Conduit can't find one, so it can't keep your password safe on this computer." |
| Current vault, off | Card with the switch off. Hint: "Open {name} without the master password when Conduit starts". Under it, when another vault has it on: "{other} unlocks automatically now. Turning this on moves it to {name}." |
| Current vault, on | Card with the switch on. Hint: "{name} opens without the master password when Conduit starts". Then the warning callout and the store line shown in the mockup. |

- Settings opens only from the main layout: `SettingsDialog` renders at `App.tsx:1119`, not in the Hub branch (`App.tsx:1000-1060`) [V]. So this section is always seen with a vault open. The old "No personal vault unlocked" state is dropped; its "Turn Off" link moved to the team-vault row, the one case where it can show.
- Switch on: opens the warning dialog with the password proof (2.2). The switch stays off until "Turn On" succeeds.
- Switch off: acts at once, no confirm. Toast "Automatic unlock is off" / "{name} asks for the master password again." The startup vault stays the same, so the next start shows its unlock prompt.
- Errors from the IPC call show as `Callout tone="danger"` under the card, like Quick Unlock (`SecurityTab.tsx:94`) [V].

### 2.6 Vault Hub

Recent rows today: `ListRow` with file name, folder, `PendingBadge` and a fingerprint icon for Quick Unlock (`src/components/vault/VaultHub.tsx:267-297`) [V]. The row context menu has "Remove from Recents" and "Copy Path" and is right-click only (`VaultHub.tsx:120-133`) [V]. "Clear All" runs `clearRecentVaults()` with no confirm (`VaultHub.tsx:262-263`) [V].

```
 Recent Vaults                                      Clear All
 +-------------------------------------------------------------+
 | [folder] Work                  +[Startup] +(lockOpen) (fp) > |
 |          /Users/chris/iCloud                                |
 | [folder] Personal                                         > |
 |          /Users/chris/Documents                             |
 +-------------------------------------------------------------+

 Right-click on a recent vault (or the Startup badge):
 +------------------------------------+
 |+ Open at Startup                   |   (or "Stop Opening at Startup")
 |+ Turn Off Automatic Unlock         |   (only when it has a saved unlock)
 |+ ---------------------------------- |
 |  Remove from Recents               |
 |  ---------------------------------- |
 |  Copy Path                         |
 +------------------------------------+
```

- "Startup" on the startup vault's row. It is a small button styled as `Badge tone="neutral"`, and it opens the same menu, so the menu is reachable from the keyboard. It also shows on a team row when that team vault is the startup choice.
- `LockOpenIcon` (size 16, `text-ink-muted`, title "Unlocks automatically on this computer", plus the same words as `sr-only` text) when it has a saved unlock. The icon exists in every pack (`src/lib/icons/index.ts:46`) [V].
- "Open at Startup" sets the startup vault. When another vault has a saved unlock, the same confirm as 2.4 runs first. Toast: "{name} opens at startup".
- "Stop Opening at Startup" sets the startup choice to "Vault Hub" and forgets the saved unlock. Toast: "{name} won't open at startup", with the message "Automatic unlock is off too." when a saved unlock was forgotten.
- "Turn Off Automatic Unlock" forgets the saved unlock and keeps the startup choice. Toast as in 2.5.
- "Remove from Recents" on the startup vault: toast "{name} won't open at startup", with "Automatic unlock is off too." when it had a saved unlock.
- "Clear All": when it would forget a saved unlock, a `ConfirmDialog` runs first: title "Clear recent vaults?", body "{name} unlocks automatically at startup. Clearing the list turns that off.", buttons "Cancel" / "Clear All". Otherwise it stays one click. When it changed the startup vault, the same toast as Remove.
- Turning automatic unlock **on** is not offered here: it needs the vault open and a fresh proof. Opening the vault and ticking the checkbox is one step away.
- Team rows (`VaultHub.tsx:199-221`) [V] get a context menu with only "Open at Startup" / "Stop Opening at Startup".
- The same recent-vault menu is used by the vault menu in the sidebar (`src/components/vault/VaultSwitcherMenu.tsx:125-138`) [V]. The code moves to one shared helper so the two stay equal.
- Missing startup vault file at start: the Hub shows with the toast `toast.warning("Couldn't find Work.conduit", { message: "It may have been moved or renamed. Conduit opened the Vault Hub.", actions: [{ label: "Open Vault File...", ... }, { label: "Stop Opening at Startup", ... }] })`. The startup choice stays, so it works again when the file comes back.

### 2.7 The quiet indicator

While the open vault has a saved unlock, a 12px `LockOpenIcon` in `text-ink-faint` sits after the vault name in the sidebar header button (`src/components/layout/Sidebar.tsx:314-323`) [V], and after the name in the vault menu's current row, next to where the network icon goes today (`VaultSwitcherMenu.tsx:163-168`) [V].

```
 [x][pin]  Work +(lockOpen) v           [*] [..]
```

- Title on the header button: the existing title, plus " · Unlocks automatically on this computer". (A middle dot, not a dash.) The button also gets `sr-only` text "Unlocks automatically on this computer", because screen readers do not reliably read `title`.
- It shows whenever the setting is on, not only after an automatic start.
- The sidebar is unpinned by default and closes itself when an entry opens (`src/stores/sidebarStore.ts:97`; `docs/FEATURES.md:678`) [V], so the icon is often hidden. Two more places carry the message:
  - Settings > Security always shows the state while a vault is open (2.5).
  - After each automatic open, one info toast: "{name} unlocked automatically" with a "Turn Off" action. It auto-dismisses like other info toasts. Owner decision 10.8 can drop it.

### 2.8 Toast list

| Event | Toast |
|---|---|
| Turned on | success "Automatic unlock is on" / "{name} opens when Conduit starts. Hold Shift while Conduit starts to skip it." |
| Turned off (any place) | info "Automatic unlock is off" / "{name} asks for the master password again." |
| Opened automatically | info "{name} unlocked automatically" [Turn Off] |
| Saved unlock updated after a password change | success "Saved unlock updated" |
| Saved unlock could not be updated | warning "Couldn't update the saved unlock" / "Conduit will ask for the password at the next start." |
| Startup vault set | success "{name} opens at startup" |
| Startup vault cleared (Stop Opening, Remove, Clear All) | info "{name} won't open at startup" (+ "Automatic unlock is off too." when one was forgotten) |
| Skipped (escape hatch or Go to Vault Hub) | info "Startup vault skipped" / "Conduit opened the Vault Hub. {name} opens next time." |
| Startup open cancelled (Cancel on a fallback dialog) | info "{name} didn't open" / "It will try again at the next start." [Stop Opening at Startup] |
| Startup file missing | warning "Couldn't find {file}" / "It may have been moved or renamed. Conduit opened the Vault Hub." [Open Vault File...] [Stop Opening at Startup] |
| Sign-out or account change forgot it | info "Automatic unlock is off" / "Signing out turns it off on this computer." (account change: "Another account signed in, so it was turned off on this computer.") |
| Release or own copy changed it | info "Automatic unlock is off" / "{name} is no longer yours to open at startup." (release) or "Your copy opens at startup. Turn automatic unlock on again from the unlock screen." (own copy) |

All through `toast` from `src/components/common/Toast.tsx`, per `.claude/commands/notification.md` [V].

---

## 3. Storage design

### 3.1 What is sealed, and why the password

- **Sealed:** the master password, in a small JSON envelope, encrypted with `safeStorage.encryptString`. Quick Unlock seals the same thing today (`electron/services/vault/biometric.ts:208-217`) [V].
- **Why not only the vault key** [V]:
  - `openPersonalVault` takes a password and derives keys per epoch salt (`electron/services/vault-session/open-password.ts:51-70`) or checks the private salt (`:115-120`).
  - The code after unlock needs the password string: chat store (`electron/ipc/vault-wiring.ts:141-159`), local and cloud backup (`vault-wiring.ts:86-121`; cloud backup derives a fresh key per blob), and `state.currentMasterPassword` for rename, password change and Quick Unlock.
  - A key-only path means a second open path, password-free backups and a new chat key. That is a large change to security-critical code.
- **The password reaches further than the key.** The vault key opens this vault's current secrets. The master password also:
  - decrypts every local backup file, wherever it was copied (`electron/services/vault/local-backup-crypto.ts:54,104` derive the key from the password) [V], and every cloud backup, both old and new;
  - opens the same vault on the user's other devices;
  - opens anything else where the same password was reused.
  So a leaked sealed entry costs more than the open vault. This is owner decision 10.6. The recommendation is to ship with the password (same as Quick Unlock today) and treat a key-only open as a later hardening step for both features.

### 3.2 When the feature is offered, and when a seal is allowed

A new `secretStoreStatus()` in `electron/services/vault/auto-unlock-store.ts`:

| Platform | Usable when | Store name in UI |
|---|---|---|
| macOS | `safeStorage.isEncryptionAvailable()` | "system keychain" |
| Windows | `safeStorage.isEncryptionAvailable()` (DPAPI) | "Windows credential store" |
| Linux | available **and** `safeStorage.getSelectedStorageBackend()` is one of `gnome_libsecret`, `kwallet`, `kwallet5`, `kwallet6` | "system keyring" |

- `basic_text` is refused because Chromium then encrypts with a fixed built-in key, which is the same as plain text [A]. `unknown` is refused because the backend is not known (it also is what the call returns before `ready`) [V: `node_modules/electron/electron.d.ts:12035-12110`].
- Nobody calls `getSelectedStorageBackend` today [V, grep]. Quick Unlock is macOS only and its `storePassword` checks only `isEncryptionAvailable()` (`biometric.ts:208-210`) [V], which is also true for `basic_text`.
- **The status is read fresh every time**, never cached. A later launch can get `basic_text` when the keyring daemon is not running or not unlocked.
- **Every seal checks it.** `sealPassword` calls `secretStoreStatus()` itself and refuses when the store is not usable. This covers the re-seal paths too (3.6). When a re-seal is refused, the old entry is deleted and the "Couldn't update the saved unlock" toast shows.

### 3.3 File location and format

- Folder: `{secretDir}/auto-unlock/`, mode `0o700`.
  - macOS and Linux: `{secretDir}` is `getDataDir()` (`electron/services/env-config.ts:145-147`) [V], so dev and production keep separate entries.
  - Windows: `getDataDir()` sits under `app.getPath('appData')` (`electron/app-identity.ts:17`) [V], which is Roaming `%APPDATA%`. With roaming profiles the entry and the DPAPI key it needs would follow the user to every domain PC [A]. So on Windows `{secretDir}` is `%LOCALAPPDATA%\{app name}\{env folder}` (from `process.env.LOCALAPPDATA`), which never roams. Not `app.getPath('sessionData')`: it defaults to `userData`, which is also Roaming [A].
  - macOS: when the folder is created, it is excluded from Time Machine (`tmutil addexclusion`, or the `com.apple.metadata:com_apple_backup_excludeItem` attribute). Migration Assistant and Time Machine carry the login keychain, so without this a restored or migrated Mac would still open the vault [A]. A failed exclusion is logged and does not block the seal.
- File: `{lineageKey}.auto.enc`, mode `0o600`, where `lineageKey = vaultLineageToKey(lineageId)` (`electron/services/vault/biometric-keys.ts:16-18`) [V]. A separate folder and suffix from `.bio.enc`, because a `.bio.enc` file existing is what "Quick Unlock is on" means (`biometric.ts:200-206`) [V].
- Content: the bytes of `safeStorage.encryptString(JSON.stringify(envelope))`:

```ts
interface AutoUnlockEnvelope {
  readonly v: 1;
  readonly lineageId: string;
  readonly userId: string | null;   // Conduit account that turned it on; null = local mode
  readonly backend: string;         // safeStorage backend at seal time ('keychain' / 'dpapi' on macOS / Windows)
  readonly password: string;
  readonly sealedAt: number;        // ms since epoch, for logs and support only
}
```

- Writes are atomic: write `{key}.auto.enc.tmp`, `fsync`, rename.
- Reads: decrypt, parse, check `v === 1`, `lineageId` equals the lineage being opened, and `backend` equals today's backend. Any failure is "unreadable" (2.1). A newer `v` is also "unreadable" and the file is kept, so a downgrade never deletes a newer entry.
- A `userId` that does not match the signed-in user is not "unreadable": the entry is deleted (4.1).
- The password never leaves the main process. No IPC returns it. Logs never include it; they name only the source `auto_unlock`. (Main logs today do leak session tokens; section 6.0 fixes that first.)

### 3.4 Keyed by lineage only

- Quick Unlock looks up the lineage key first, then a legacy path key (`electron/ipc/biometric-lineage.ts:24-43`) [V]. Automatic unlock is new, so it uses **only** the lineage key. No path key, no migration.
- Lineage of a path: `appSync.lineageForPath` (`electron/services/sync/app-sync-manager.ts:425-427`) [V]. For a shared vault it is the lineage bound to that real path; otherwise it is read from the file (`electron/services/sync/app-sync-lineage.ts:43-50`) [V].
- If the lookup fails or returns `null`, there is no automatic unlock: the normal prompt shows.
- **Invariant: at most one `.auto.enc` file exists**, and it belongs to `settings.startup_vault` when that is a personal vault. Sealing a new entry removes every other one. At each start, main deletes any entry whose key is not the startup vault's lineage key.

### 3.5 Non-secret settings

New key in `AppSettings` (`electron/ipc/settings.ts:64-116`) [V], default `null`:

```ts
type StartupVault =
  | { readonly kind: 'hub' }
  | { readonly kind: 'personal'; readonly path: string; readonly lineageId: string | null }
  | { readonly kind: 'team'; readonly teamVaultId: string };

startup_vault: StartupVault | null; // null = "Last team vault used": today's rule (last team vault, else Hub)
```

- Stored by path **and** lineage. The path is what opens; the lineage checks it is still the same vault and finds the sealed entry.
- Whether automatic unlock is on is **not** a setting. It is "the startup vault is personal and its `.auto.enc` exists". Same model as Quick Unlock, so the two can never disagree.
- The sealed secret never goes in `settings.json`.
- Validation on read: an unknown `kind`, a non-absolute path or an empty id reads as `null`, with a warning in the log.

### 3.6 Re-seal on password change

| Where the new password is learned | Hook | Action |
|---|---|---|
| Change password on this device | `changePassword` in `electron/ipc/vault-manage.ts:125-152`, next to `restoreBiometricAfterPasswordChange` (`:150`) [V] | Capture "was on" before the change. After success, seal the new password under the vault's current lineage key, delete the old key (a private vault's lineage follows its salt), and update `startup_vault.lineageId`. |
| Sync flows: new password after a change elsewhere, legacy adopt, concurrent epoch | `applyVaultPasswordChange` (`electron/ipc/sync-password.ts:37-47`) [V], reached from `followPassword` (`electron/ipc/sync.ts:91-94`) [V] | Same as above. |
| Startup attempt failed, user typed the new password with the checkbox checked | Unlock dialog success path (2.1) | Seal the new password. |
| `PasswordChangedElsewhereDialog` after an automatic attempt | Same retry path, attempt kind `"saved"` | See below. |

**The password-changed dialog after an automatic attempt.** Today it asks for the new password and, when `needsPreviousPassword` is set, for the previous one too (`src/components/sync/PasswordChangedElsewhereDialog.tsx:34-63`; `open-password.ts:95-99`) [V]. The previous password is exactly the saved one, which users of automatic unlock are the most likely to have forgotten. For attempt kind `"saved"`:
- Main holds the saved (old) password in memory for the life of the startup attempt (4.3), even though the file is already deleted (4.4). On the retry it fills `previousPassword` itself when the renderer sends none.
- The dialog hides the "Previous master password" field.
- One added line under the text: "Conduit couldn't open {name} automatically."
- The same "Keep unlocking automatically at startup" checkbox, checked by default, next to the existing Quick Unlock note (`:64-65`) [V].
- Success with the box checked seals the new password and shows "Saved unlock updated". Unchecked shows "Automatic unlock is off".

All re-seals go through `sealPassword`, so they check the store (3.2). All are best effort: a failure is logged, deletes the old entry, and shows the toast `toast.warning("Couldn't update the saved unlock", "Conduit will ask for the password at the next start.")`. They never fail the password change.

### 3.7 Invalidation and lifecycle table

| Event | Saved unlock | Startup choice | Code anchor |
|---|---|---|---|
| Password changed on this device | Re-sealed (3.6) | Lineage updated | `vault-manage.ts:125-152` [V] |
| Password changed elsewhere, learned in a session | Re-sealed | Lineage updated | `sync-password.ts:37-47` [V] |
| Password changed elsewhere, found at startup | Forgotten at once; stale prompt (2.1) or password-changed dialog (3.6) offers to seal the new one | Kept | `open-password.ts:51-70` [V] |
| Saved password rejected as "Invalid master password" at startup | Forgotten at once; stale prompt | Kept | 4.4 |
| Rename in the app (shared or in place) | Kept (lineage unchanged) | Path follows | `recordRenameInSettings`, `vault-manage.ts:44-49` [V] |
| File moved or renamed and followed by sync | Kept | Path follows | `AppState.followSharedFile`, `electron/services/state.ts:246-257` [V] |
| Startup file missing at start | Kept | Kept; Hub + toast | new, 4.2 |
| Another vault now at the startup path | Kept for the old lineage; not used | Kept; normal prompt for the file at the path, with no automatic attempt | 4.2 |
| Remove from Recents | Forgotten when it is that vault; toast | Reset to Vault Hub when it is that vault | `removeRecentVault`, `electron/ipc/recent-vaults.ts:41-50` [V] |
| Clear All recents | All forgotten, after a confirm when one existed; toast | A personal startup vault resets to Vault Hub | `clearRecentVaults`, `recent-vaults.ts:52-61` [V] |
| Choose another startup vault | Forgotten (after the confirm) | Changed | new `startup_vault_set` |
| Turn off (any place) | Forgotten | Kept | new `auto_unlock_disable` |
| Sign out (user clicks Sign Out) | All forgotten; toast | Kept (it only prompts now) | `auth_sign_out`, `electron/ipc/auth.ts:102-108` [V] |
| Forced sign-out (MFA required, suspension) | All forgotten | Kept | user id change, below |
| Any change of signed-in user id (A to null, A to B, null to A), including a `conduit://auth/callback` link | All forgotten; toast | Kept | `processDeepLink` sets a session with no confirm (`electron/main.ts:106-127`) [V]; `watchSignOut` sees only A to null today (`state.ts:263-272`) [V]; a new watcher in `auto-unlock-lifecycle.ts` covers every change |
| Release ownership | Forgotten for that vault; toast | Reset to Vault Hub when it is that vault | `sync_release_ownership`, `electron/ipc/sync.ts:147` [V] |
| Make my own copy | Forgotten for the original; toast | Moves to the copy's path and new lineage | `sync_make_own_copy`, `sync.ts:148-150` [V] |
| Make a separate vault | Unchanged (the original keeps its lineage) | Unchanged | `sync_make_separate_vault`, `sync.ts:133-135` [V] |
| Vault delete | There is no vault delete in the app [V, grep] | n/a | n/a |
| Secret store stops working, the entry cannot be decrypted, or the backend changed | Kept; unreadable prompt (2.1) | Kept | new |
| Linux launch with a weak backend, then a re-seal | Refused; old entry deleted; toast | Kept | 3.2 |
| Private vault becomes shared (sync turned on) | If the lineage changes, the entry is not found; normal prompt; the checkbox re-seals [A] | Lineage updated after the next unlock | 9, item 6 |
| App update | Kept | Kept | [A] macOS may ask for Keychain access after a signature change |
| Windows roaming profile, another PC | Not there: the folder is under `%LOCALAPPDATA%` (3.3) | Roams with settings; the other PC shows the unlock prompt | 3.3 |
| macOS Time Machine restore or Migration Assistant | Not carried: the folder is excluded (3.3) [A] | Carried; the unlock prompt shows | 3.3 |
| Uninstall | The data folder and entry stay behind [A] | Same | Documented in FEATURES |

---

## 4. Startup sequence

### 4.1 Who decides what

- **Main owns the decision and the one-shot.** React StrictMode runs mount effects twice in dev (`src/main.tsx:9-13`) and the renderer re-mounts after a reload or crash (`electron/main.ts:925-935`) [V]. A guard in the renderer alone would allow a second attempt.
- **The renderer waits for sign-in to settle.** Today the vault init effect reads the auth store without waiting for `isInitializing` (`src/App.tsx:438-510` vs `:186-189`) [V]. The new routine runs only when `isInitializing` is false and the auth gate lets the app through: `authMode` is `authenticated`, `local` or `cached` (`App.tsx:984-991`) [V], and onboarding is not showing (`App.tsx:994-996`) [V].
- **Main checks the account too.** The renderer wait is not enough on its own. In `vault_auto_unlock`, main requires:
  - auth has finished initializing (a new `hasInitialized()` on `AuthService`; `initialize()` clears its promise when done, `electron/services/auth/supabase.ts:149-156` [V], so it cannot be awaited later);
  - the current user id (`authService.getAuthState().user?.id ?? null`; cached mode keeps the user, `supabase.ts:195-205` [V]) equals `envelope.userId`.
  Otherwise it deletes the entry, returns `{ ok: false, fallback: 'account' }`, and the renderer shows the normal prompt with the account-change toast.
- **MCP.** `McpGatekeeper.computeAccess` allows MCP when there is no profile (`electron/services/mcp-gatekeeper.ts:53-62`) [V], and tools work as soon as the vault is unlocked. Running after the auth gate means a vault is never opened behind the sign-in screen. Section 4.8 adds the input hold.

### 4.2 Sequence at launch

```
main whenReady
  1. read switch --no-startup-vault; run the macOS modifier probe once (4.5)
  2. note whether this launch carries a conduit:// URL (open-url before ready,
     or pendingDeepLinkUrl, main.ts:88-98, 183) [V]
  3. createWindow; attach the short before-input-event collector (4.5)
renderer
  4. auth initialize (unchanged)
  5. wait: auth settled and gate passed (4.1)
  6. checkVaultStatus; already unlocked -> done (unchanged, App.tsx:444-449)
  7. pending file association -> open it + unlock dialog (unchanged, :452-463);
     tell main: vault_startup_done
  8. plan = invoke('vault_startup_plan')          <- main consumes the one-shot
main vault_startup_plan
  a. one-shot already used this start         -> { kind: 'none' }
  b. escape hatch (switch, Shift/Option seen)  -> { kind: 'hub', skipped: name }
  c. startup_vault null                        -> { kind: 'automatic' }   (today's team rule)
  d. startup_vault hub                         -> { kind: 'hub' }
  e. startup_vault team                        -> { kind: 'team', teamVaultId }
  f. startup_vault personal:
       path missing on disk                    -> { kind: 'hub', missing: fileName }
       lineageForPath(path) != stored lineage  -> { kind: 'personal', path, auto: false }
       launch carries a conduit:// URL         -> { kind: 'personal', path, auto: false }
       entry exists and store usable           -> { kind: 'personal', path, auto: true }
       else                                    -> { kind: 'personal', path, auto: false }
renderer acts on the plan
  none/hub      -> Hub (+ toast when skipped or missing)
  automatic     -> today's team auto-connect block, else Hub (App.tsx:465-507)
  team          -> same block with plan.teamVaultId; needs authenticated,
                   team member, identity key (App.tsx:479-484); else Hub + the
                   existing autoConnectError banner with Retry (VaultHub.tsx:146-154)
  personal auto -> "Opening {name}..." screen, invoke('vault_auto_unlock')
  personal      -> openVault(path) + unlock dialog (Touch ID auto-starts when on,
                   UnlockDialog.tsx:77-89)
```

- The plan for a team or automatic start keeps today's team rules. Only the vault id comes from the setting.
- `vault_auto_unlock` does everything in main: the account check (4.1), `lockPersonalVault`, `switchVault(startupPath)`, `updateRecentVaults`, read the entry, then `openPersonalAndFinish` with `source: 'auto_unlock'` and `takeover: false` (`electron/ipc/vault-unlock.ts:87-107, 136-142`) [V]. The renderer never names the path, so it cannot aim the saved password at another file.
- `'auto_unlock'` is added to `UnlockSource` (`electron/services/vault-session/open-personal-vault.ts:46-55`) [V]. In `verifySharedPassword`, `deleteBiometric` stays tied to `'biometric_unlock'` (`open-password.ts:65`) [V]; automatic unlock handles its own stale entry (4.4).

### 4.3 The startup attempt and its retries

A main-side `StartupAttempt` (new, `electron/ipc/startup-vault.ts`):

| State | Meaning |
|---|---|
| `armed` | Set at process start, and again on a qualifying window re-show (4.6). |
| `used` | `vault_startup_plan` returned a plan. |
| `open` | A personal automatic attempt ran and did not succeed. User-driven retries are allowed. |
| `done` | Success, cancel (`vault_startup_done`), any lock, opening any other vault, or 10 minutes passed. |

- `vault_auto_unlock` works in `used` (the first try) and `open` (retries). Anything else gets `{ ok: false, fallback: 'not-allowed' }` and the renderer shows the normal prompt.
- The attempt keeps the saved password in main memory from the first read until `done`, so retries still work after the file is deleted (4.4) and the password-changed dialog can supply the previous password (3.6). It is dropped at `done`.
- Retries come only from user clicks in the existing dialogs: "Use here instead" (take-over, `UnlockErrorView.tsx:40-47`) [V], "Recover" (damaged working copy, `:61-70`) [V], and "Try Again" (2.1). These repeat the last attempt kind. `UnlockDialog` gets a third `AttemptKind`, `"saved"`, beside `"password"` and `"biometric"` (`UnlockDialog.tsx:15, 69-75, 124-145`) [V].
- `takeover: true` is accepted only on a retry, never on the first try. Main enforces this, not the renderer. Main cannot tell a real click from injected script (5.2).
- The dialog's `takeoverMode` merge (`UnlockDialog.tsx:72`) [V] is false at startup, because only a user choice sets it (`DisplacedDialog.tsx:94`, `SyncBanners.tsx:17`) [V per fact sheet].

### 4.4 Outcomes of an automatic attempt

| Result of `openPersonalAndFinish` | What the user sees | Saved unlock |
|---|---|---|
| Success | The vault opens. No dialog. Info toast "{name} unlocked automatically" (2.7). Main log: `personal vault unlocked { source: 'auto_unlock' }` | Kept |
| `VAULT_OPEN_ELSEWHERE` (Free vault open on another device, or the device cap) | The normal take-over dialog. "Use here instead" retries with the saved password and `takeover: true`. Cancel closes the unlock dialog: Hub + "Startup open cancelled" toast. | Kept |
| `VAULT_NOT_OWNER` | The normal not-owner dialog with "Make my own copy". Cancel as above. | Kept (own copy: 3.7) |
| `VAULT_SIGN_IN_REQUIRED` | The normal sign-in dialog. Cancel as above. | Kept |
| `VAULT_UPDATE_REQUIRED` | The normal update dialog. Cancel as above. | Kept |
| `VAULT_WORKING_COPY_DAMAGED` | The normal dialog; "Recover" retries with the saved password. Cancel as above. | Kept |
| `VAULT_PASSWORD_CHANGED_ELSEWHERE` | The password-changed dialog in its "saved" form (3.6): new password only, a line saying the automatic open failed, and the keep checkbox. | **Forgotten at once**; re-sealed on success when the box is checked |
| "Invalid master password" | The stale prompt (2.1). | **Forgotten at once**; re-sealed on success when the box is checked |
| `VAULT_FILE_UNREADABLE` | The error line plus "Try Again" (2.1). | Kept |
| `VAULT_FOREIGN_FILE` | The error line. | Kept |
| "Vault file not found" (a race after the plan's check) | Hub + the missing-file toast. | Kept |
| The entry cannot be read or decrypted, or the backend changed | The unreadable prompt (2.1). | Kept |
| Account check failed (4.1) | The normal prompt + account-change toast. | Forgotten |
| Cancelled by "Go to Vault Hub" | Hub + "Startup vault skipped" toast. The cancel is `lockPersonalVault`, which ends an open in progress with `OPEN_CANCELLED` (`electron/ipc/vault-lock-flow.ts:41-59`, `app-sync-manager.ts:192-221`) [V]. | Kept |

- Why forget a stale password at once: a password changed elsewhere is often a reaction to a leak, and the old password still decrypts older local and cloud backups (3.1). Keeping it adds exposure and gains nothing. Quick Unlock already deletes its entry in this case (`open-password.ts:65`) [V]. The one-shot per start already prevents loops, and the pre-checked box re-seals the new password.
- In every fallback, the unlock dialog does not start Touch ID by itself (2.1).
- Every gate row above comes from `earlyInUseCheck` or the later acquire, which run for every source (`electron/services/vault-session/open-gate.ts:57-77`) [V]. Nothing here is new; automatic unlock only supplies the password.
- **Offline.** The early check is bounded and an unconfirmed answer continues to the owner tag and claims (`open-gate.ts:59-76`) [V]. With `authMode` `cached` the vault opens as it does today and the `OfflineBanner` shows (`App.tsx:1007`) [V].
- **Grace and plan banners** show after the open, as for any unlock.
- **Structured errors reach the dialog unchanged.** `openPersonalAndFinish` flattens the typed error for the renderer (`vault-unlock.ts:41-43, 95-99`) [V] and the renderer turns it into `syncStore.openError` like `biometricUnlock` does (`src/stores/vaultStore.ts:879-894`) [V].

### 4.5 Escape hatch

Three ways, all ending in the Hub for this start only. Only a modifier held **as Conduit starts** counts. The plan waits for sign-in and onboarding (4.2 step 5), so a collector that ran until the plan would count Shift typed into the sign-in form (capital letters) as "skip" (`App.tsx:984-996` renders `AuthScreen` and onboarding first) [V].

1. **Hold Shift (or Option on a Mac) while Conduit starts.**
   - macOS: main runs `osascript -l JavaScript -e 'ObjC.import("AppKit"); $.NSEvent.modifierFlags'` **once**, at `whenReady`. Shift is bit `0x20000`, Option `0x80000`. Timeout 1.5 s; a timeout or error means "not held". On this Mac it returns `0` with no key held, in 0.12 s, with no permission prompt [V]. Reading a held key this way is [A]. There is no second probe when the plan is made.
   - Every platform: `webContents.on('before-input-event')` counts a key event with `shift` (or `alt` on macOS) set, **only for 1.5 s after the window first shows**. The collector stops early as soon as the renderer reports that `AuthScreen`, onboarding or any text field has focus. Windows repeats a held Shift key to the focused window, so this covers Windows [A]. On Linux it depends on the window manager [A].
   - The result is fixed when the collector stops. The plan only reads it.
   - The existing Swift helper is not used: it is compiled with `swiftc` on first use (`biometric.ts:139-175`) [V], which needs developer tools and would slow the first start.
   - Electron has no API for the current modifier state [V, grep].
2. **"Go to Vault Hub"** on the opening screen (2.3). Works on every platform and is visible.
3. **Command line:** `--no-startup-vault` (`app.commandLine.hasSwitch`). Also used by the live tests.

The skip is shown with the toast "Startup vault skipped". The setting does not change.

### 4.6 After a lock, and when the window opens again

**Rule:** automatic unlock replaces the password only when Conduit starts, or when its window opens again after a close that locked a vault that had opened automatically and had not been locked since. Once the vault is locked by a choice (Lock command, idle lock, screen lock), it asks for the password or Touch ID until the next start, even across a close and reopen of the window.

- **Why a lock still asks.** The user or their idle-lock setting chose "lock now". If the Hub reopened the vault by itself, Lock and the idle lock would mean nothing. It also keeps MCP agents locked out after an idle lock until someone comes back to the computer. It is a speed bump, not a wall: anyone at the computer can quit and reopen Conduit. The Security section says so plainly (2.5).
- **Why closing the window can count as a start.** Closing the window locks the vault and hides the app to the tray or Dock (`electron/main.ts:758-778`) [V]. The lock is a side effect of hiding, not a choice to lock. Reopening from the Dock or tray is the same act as starting Conduit, and gives nobody more than a quit and relaunch would. Without this rule the feature would feel broken on macOS, where closing the window is the normal way to put an app away.
- **The close handler today cannot tell these cases apart.** It always runs `lockVaultFromMain()` and always sends `vault-locked-by-system`, even when nothing was open (`main.ts:767-773`; `electron/ipc/vault.ts:22-24` returns `void`) [V]. So Lock, then close, then reopen from the Dock would reopen the vault by itself. The fix:
  - `lockVaultFromMain()` returns whether it closed an open personal vault.
  - Main keeps `autoOpenedAndNotLocked`: set by a successful `vault_auto_unlock`; cleared by any lock that is not the close handler's (Lock command, idle lock, screen lock, backup restore), by opening another vault, and by a user unlock of any kind.
  - The close handler re-arms the attempt only when its lock closed a vault **and** that flag was set. It then remembers `rearmOnShow`.
  - The idle and screen locks send `vault-locked-by-system` with `{ reason: 'idle' }` / `{ reason: 'screen-lock' }` (`electron/ipc/vault-idle.ts:23-27` sends no payload today [V]); the close handler sends `{ reason: 'window-closed' }` and only when something was open.
- **Re-show.** When the window shows again and `rearmOnShow` is set, main sets the attempt to `armed`, clears `rearmOnShow` and sends `vault-startup-again`. The renderer runs the same routine from step 6 of 4.2. The escape hatch collector runs again for 1.5 s.
- A `second-instance` launch (`main.ts:160-178`) [V] calls `win.show()` for any second launch. It re-arms only through the same `rearmOnShow` flag, and **never** when its command line carries a `conduit://` URL or a `.conduit` file argument. A local program that launches Conduit a second time gains nothing it could not get by quitting and relaunching it (5.2).
- Reopening does nothing when a vault (personal or team) is already open.

### 4.7 Team startup vault

- A team vault opens with no password: the identity key comes from `safeStorage` with a plain-text fallback (`electron/services/vault/team-crypto.ts:98-122`) [V per fact sheet]. Picking one as the startup vault adds no new secret, so there is no warning. The Settings hint says: "Team vaults open without a password on this computer."
- The conditions stay those of today's auto-connect: `authenticated`, team member, identity key present (`App.tsx:479-484`) [V].
- Offline (`cached`), not a member any more, or the vault is gone: Hub with the existing `autoConnectError` banner and Retry (`VaultHub.tsx:95-118, 146-154`) [V]. `handleRetryAutoConnect` reads the startup choice first, then falls back to `last_team_vault_id`.
- Choosing "Last team vault used" keeps today's behavior exactly.

### 4.8 MCP after an automatic unlock (recommended; owner decision 10.7)

- The MCP socket checks only the file mode (`chmod 0600`, `electron/ipc-server/server.ts:2050-2056`) [V]; there is no client token. `CredentialGet` returns the plain password to any client while the vault is unlocked (`server.ts:285-310`) [V]; the approval step for `credential_read` lives only in the MCP process (`mcp/src/index.ts:223-224`, `mcp/src/tools/credential.ts:156-166`) [V], which any other program can skip by talking to the socket directly. The gatekeeper allows MCP on every plan (`mcp-gatekeeper.ts:53-62`) [V].
- So with automatic unlock, any program running as the user can launch Conduit (`open -a Conduit`, or a second launch) and read every password, with no person present. This is pre-existing for a vault the user unlocked by hand; automatic unlock removes the need for the person.
- **Hold:** `vault_auto_unlock` sets `mcpHeldUntilInput` just before it starts the open, not after it: the working copy is readable while the first sync cycle and the presence writes still run. A failed open leaves it set; a lock or a person's input clears it. While set, `handleRequest` answers every vault-touching request with the existing locked response (`lockedResponse`, `server.ts:263, 288, ...`) [V] and message "Waiting for you to use Conduit". It clears on:
  - the first `before-input-event` of type `keyDown` in the main window after the escape-hatch window closes (4.5), or
  - the first trusted `pointerdown` in the renderer (`event.isTrusted`), reported over IPC.
  A typed-password or Touch ID unlock never sets it.
- The warning's second sentence then reads: "AI agents and other programs on this computer can use it once you click or type in Conduit." (Replaces "as soon as Conduit starts" in 2.2 and 5.1 if the owner picks the hold.)
- The live test `mcp-after-auto-unlock` (8.2) covers both: held before input, allowed after.

---

## 5. Security analysis

### 5.1 Warning text (final)

> Anyone who can use this computer while you are logged in to it can open this vault and see its passwords. AI agents and other programs on this computer can use it as soon as Conduit starts. Only turn this on for a computer that only you use and that locks with a password.

With the MCP hold (4.8), the second sentence becomes: "AI agents and other programs on this computer can use it once you click or type in Conduit."

Short form, used in Settings > Security:

> Anyone who can use this computer while you are logged in can open this vault. Locking still asks for the password, but closing or quitting Conduit and opening it again does not.

### 5.2 Threats

| Who | Before | With automatic unlock | Verdict |
|---|---|---|---|
| Someone at your unlocked, logged-in computer | Needs the master password (or your finger for Touch ID) once Conduit is locked or closed | Can open the vault by quitting and reopening Conduit, or by closing and reopening its window when it had opened automatically | Accepted. This is the feature. The warning says it in plain words. |
| Thief with the computer turned off or logged out | Needs the master password | Needs your OS login first. The sealed entry is bound to your OS account: Keychain on macOS, DPAPI on Windows, the keyring on Linux, each unlocked by your login password [A] | Same protection as your OS login. FileVault or BitLocker add more. |
| Copy of the Conduit data folder on another computer (backup, sync tool, theft of files) | Useless without the password | The entry sits outside the roaming folder on Windows and is excluded from Time Machine on macOS (3.3). A copy of the file alone does not decrypt without this OS account's store [A]. Not covered: a full disk image or a manual copy of both the keychain and the folder, and Windows domain admins, who can decrypt DPAPI through the domain backup key [A] | Mostly safe. The limits are stated here and in FEATURES. |
| Any program running as you | Can wait for you to type the password, or read memory while the vault is open. Can read every password over the MCP socket while you have the vault open (4.8) | **Can start Conduit and read every password over the MCP socket, no prompt, no person present (4.8).** Can also decrypt the sealed entry with no prompt on every OS: DPAPI and the keyring let any process of the user decrypt [A]; on macOS the Keychain trusts Conduit's code signature, and today's build lets any program run that signed binary with `--inspect` or `NODE_OPTIONS` (fuses verified below) | Not protected until 6.0 (fuses, macOS) and 4.8 (MCP hold) ship, and only partly after. Stated in the warning ("other programs on this computer"). |
| AI agents over MCP | Can use the vault only while you have it unlocked | Can use it from startup, without you at the screen, unless the MCP hold (4.8) is on | Accepted and stated in the warning. Automatic unlock runs only after sign-in settles (4.1), MCP calls stay audited, and a lock still stops them until the next start (4.6). |
| Another person using the same OS account | Needs the password | Can open the vault | Accepted; the warning says "a computer that only you use". Sign-out and any account change forget the saved unlock (3.7). |
| Someone who gets Conduit signed in to another account (for example a `conduit://auth/callback` link from a web page, which sets a session with no confirm, `main.ts:106-127` [V]) | Vault stays locked | Stays locked: the account check (4.1) fails, the entry is deleted, and a launch carrying a `conduit://` URL never auto-unlocks (4.2) | Safe after the checks. |
| A compromised renderer (for example injected script) | Cannot open a locked vault, but can read any password typed into it | Can turn automatic unlock on within 120 s of any normal unlock without the warning (5.4), and can send a take-over retry while an attempt is `open`; main cannot tell that from a click. No IPC returns the saved password | **Not protected**, as today: a compromised renderer already reads typed passwords, and Quick Unlock can be turned on with no proof at all (`electron/ipc/biometric.ts:66-72`) [V]. |
| Other devices of the same account | Their own password prompts | Unchanged: nothing is synced | Safe. |

**Fuses, verified on this Mac.** `npx @electron/fuses read --app /Applications/Conduit.app` [V]: `RunAsNode` Enabled, `EnableNodeOptionsEnvironmentVariable` Enabled, `EnableNodeCliInspectArguments` Enabled, `EnableEmbeddedAsarIntegrityValidation` Disabled, `OnlyLoadAppFromAsar` Disabled. There is no fuse step in `electron-builder.yml` or `scripts/afterPack.cjs` [V]. `build/entitlements.mac.plist` has `com.apple.security.cs.disable-library-validation` [V]. `RunAsNode` is in use: the packaged Claude Code engine spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (`electron/services/ai/engines/claude-code-engine.ts:541-552`) [V]. The same hole affects Quick Unlock's `.bio.enc` files today: the Touch ID check is only app logic.

### 5.3 Why these choices are safe enough

1. **The OS secret store is the only place that can open at startup without a person and still be tied to the OS login.** Any key Conduit kept itself would sit next to the sealed file and protect nothing.
2. **Password versus key.** The password reaches further than the key: all local and cloud backups, the vault on other devices, and any reused site (3.1). Sealing the password matches Quick Unlock today; moving both to a key is owner decision 10.6.
3. **At most one sealed entry** (3.4), and it is removed whenever it stops being needed (3.7), including as soon as it proves stale (4.4). Quick Unlock entries are separate and unchanged.
4. **Weak stores are refused at every seal**, not silently accepted (3.2). Other `safeStorage` users fall back to plain text today (`electron/services/auth/supabase.ts:750-773`) [V]; this feature does not.
5. **No gate is skipped** (4.4). Take-over always needs a click. The owner tag, device cap and plan checks run as for a typed password.
6. **No loops.** One automatic attempt per start; retries are user clicks; a stale saved password is deleted, never retried (4.3, 4.4).
7. **A lock keeps its meaning inside a session** (4.6), including across a close and reopen of the window.
8. **Consent at the moment of risk.** It is off by default, needs a fresh proof, shows the warning every time it is turned on, and stays visible (2.7).
9. **Bound to the account** that turned it on (4.1).

### 5.4 Proof when turning it on

`auto_unlock_enable` takes one of:

| Proof | Accepted when |
|---|---|
| `{ kind: 'recent-unlock' }` (from the unlock dialog checkbox) | Main recorded an interactive unlock of the current vault less than 120 s ago, with source `vault_unlock`, `biometric_unlock`, `vault_create` or `vault_initialize`. Never `auto_unlock`. The record is cleared on lock and on use. |
| `{ kind: 'password', password }` (Settings) | `crypto.timingSafeEqual` of SHA-256 digests of the given password and `state.currentMasterPassword` (set on every unlock by `wireBackupServices`, `vault-wiring.ts:124-134`) [V]. |
| `{ kind: 'biometric' }` (Settings, Quick Unlock on) | The LAContext helper returns `success` (`biometric.ts:219-244`, reason "Turn on automatic unlock for Conduit") [V per fact sheet]. |

It then checks the store (3.2), seals `state.currentMasterPassword` (never a password sent by the renderer, except for the comparison above) with the current user id and backend under the current lineage key, and sets `startup_vault` to the current vault.

The proof stops a person who walks up to an open Conduit from turning it on without the password. It does not stop a compromised renderer (5.2).

---

## 6. File-by-file changes

New files stay small (the repo's 200-400 line habit). `src/stores/vaultStore.ts` (895 lines) and `src/App.tsx` (1295 lines) are already large [V, `wc -l`], so new logic goes in new files.

### 6.0 Prerequisites (separate commits, before the feature)

| Item | Change | Why |
|---|---|---|
| Fuse hardening | In `scripts/afterPack.cjs`, use `@electron/fuses` to set `EnableNodeCliInspectArguments=false`, `EnableNodeOptionsEnvironmentVariable=false`, `OnlyLoadAppFromAsar=true`, `EnableEmbeddedAsarIntegrityValidation=true` (with electron-builder's asar integrity), on every platform. Drop `disable-library-validation` from `build/entitlements.mac.plist` if nothing needs it (check the FreeRDP helper and native modules). | 5.2: today any program running as the user can run Conduit's signed binary with a debugger and read the Keychain with no prompt. Also closes the same hole for Quick Unlock. |
| `RunAsNode` | Stays on for now: the Claude Code engine needs it (`claude-code-engine.ts:541-552`) [V]. Turning it off needs another way to run the SDK's `cli.js` (for example a bundled Node, or `utilityProcess` if the SDK spawn hook accepts it [A]). Owner decision 10.9. While it is on, the macOS row in 5.2 stays "not protected". | Run as Node plus `disable-library-validation` still lets a program load its own native code under Conduit's signature [A]. |
| Token logging | `electron/main.ts:94` logs the whole deep-link URL, and `electron/services/auth/supabase.ts:507` logs the refresh token [V]. The logger writes console output to rotating files (`electron/services/logger.ts:118-128`; `main.ts:792`) [V]. Log only presence and length. Add a unit test that the deep-link path logs no token material. | A refresh token in a log file restores the session, which undercuts the account binding (4.1). The live suite reads main logs. |

### 6.1 Main process

| File | Change |
|---|---|
| `electron/services/vault/auto-unlock-store.ts` (new) | `secretStoreStatus()` (read fresh each call), `secretDir()` (3.3: `%LOCALAPPDATA%` on Windows; Time Machine exclusion on macOS), `sealPassword(lineageId, userId, password)` (checks the status itself; atomic, 0600; removes all other entries; refuses and deletes the old entry when the store is not usable), `readPassword(lineageId)` returning `ok` / `missing` / `unreadable` (with the envelope's `userId`), `hasEntry(lineageId)`, `removeEntry(lineageId)`, `removeAll()`, `removeAllExcept(lineageId)`. Takes `safeStorage`, `fs`, `env` and the platform as injectable deps for tests. |
| `electron/services/vault/startup-modifiers.ts` (new) | The one macOS `osascript` probe with timeout, the 1.5 s `before-input-event` collector with its early stop, `--no-startup-vault`. Returns `isSkipRequested()`. |
| `electron/ipc/startup-vault.ts` (new) | `StartupAttempt` (4.3) with the in-memory saved password, `autoOpenedAndNotLocked` and `rearmOnShow` (4.6), `readStartupVault` / `writeStartupVault` with validation, pure helpers `withStartupPathMoved(settings, from, to)`, `withStartupCleared(settings, path)`, and the handlers `vault_startup_plan`, `vault_startup_done`, `startup_vault_get`, `startup_vault_set`, `startup_input_focus` (renderer reports text focus or the auth screen, 4.5). |
| `electron/ipc/auto-unlock.ts` (new) | Handlers `auto_unlock_status`, `auto_unlock_enabled_for_path`, `auto_unlock_enable`, `auto_unlock_disable`, `vault_auto_unlock` (account check, 4.1). The `onRefused` hook deletes the entry on INVALID and `CHANGED_ELSEWHERE` and returns the stale fallback. Retries with kind `"saved"` fill `previousPassword` from the attempt (3.6). |
| `electron/ipc/auto-unlock-lifecycle.ts` (new) | `resealAfterPasswordChange(state, before, next)`, `forgetForPath`, `forgetAll`, `afterRelease`, `afterOwnCopy`, and `watchAccountChange(authService)`: forgets all entries on any change of user id and sends `auto-unlock-forgotten` with `{ reason: 'sign-out' | 'account' }`. Best effort, logged, never throws. |
| `electron/services/auth/supabase.ts` | `hasInitialized()` flag set when `_doInitialize` resolves. Token logging fix (6.0). |
| `electron/services/vault-session/open-personal-vault.ts` | Add `'auto_unlock'` to `UnlockSource` (`:46-55`) and fix the comment "nine unlock paths" to ten. |
| `electron/ipc/vault-unlock.ts` | Record the last interactive unlock (source, lineage, time) in `openPersonalAndFinish` for the proof in 5.4. Any non-automatic unlock clears `autoOpenedAndNotLocked`. |
| `electron/ipc/vault-manage.ts` | `changePassword`: call `resealAfterPasswordChange` next to `restoreBiometricAfterPasswordChange` (`:150`). `recordRenameInSettings` (`:44-49`): also move `startup_vault.path`. |
| `electron/ipc/sync-password.ts` | `applyVaultPasswordChange` (`:37-47`): re-seal. |
| `electron/ipc/sync.ts` | Release (`:147`) and own copy (`:148-150`): call `afterRelease` / `afterOwnCopy` on success. |
| `electron/services/state.ts` | `followSharedFile` (`:246-257`): also `withStartupPathMoved`. Register `watchAccountChange` next to `watchSignOut`. |
| `electron/ipc/settings.ts` | Add `startup_vault` to `AppSettings` and `defaultSettings`. `recentVaultDeps` (`:245-257`) gains `forgetAutoUnlock` and `forgetAllAutoUnlock`. |
| `electron/ipc/recent-vaults.ts` | Deps gain the two forget calls; `withoutRecentVault` also clears a matching personal `startup_vault`; `clearRecentVaults` clears a personal one. Both return what they changed, for the toasts. |
| `electron/ipc/auth.ts` | `auth_sign_out` (`:102-108`): `forgetAll` after sign-out (the account watcher would also catch it; this keeps the order explicit). |
| `electron/ipc/vault.ts` | `lockVaultFromMain()` returns `Promise<boolean>`: whether it closed an open personal vault. |
| `electron/ipc/vault-idle.ts`, `electron/main.ts` close handler | `vault-locked-by-system` carries `{ reason }`; the close handler sends it only when the lock closed something (4.6). Every non-close lock ends the attempt and clears `autoOpenedAndNotLocked`. |
| `electron/main.ts` | Run the modifier probe at `whenReady`; note a `conduit://` launch; attach the input collector to the main window; the close handler sets `rearmOnShow` per 4.6; re-arm on `show`; `second-instance` never re-arms with a URL or file argument. |
| `electron/ipc-server/server.ts` | `handleRequest` (`:142`) returns the locked response while `mcpHeldUntilInput` is set (4.8). |
| `electron/ipc/index.ts` | Register the two new handler files next to `registerBiometricHandlers()` (`:123`) [V]. |
| `electron/preload.cts` | No change: it passes any channel (`preload.cts:6-7`) [V per fact sheet]. `vault-startup-again` and `auto-unlock-forgotten` go through the existing `on` helper. |

### 6.2 Renderer

| File | Change |
|---|---|
| `src/stores/startupVaultStore.ts` (new) | `status` (store usable, reason, store name), `startupVault`, `autoUnlockOn` for the current vault, `openingName`, `fallback` (`stale` / `unreadable` / null), `fromAutomaticAttempt`, and actions `refresh`, `setStartup`, `enable`, `disable`, `autoUnlock`, `cancelOpening`. |
| `src/lib/startup-vault.ts` (new) | `runStartupVault()`: the renderer part of 4.2, used by the App init effect and by `vault-startup-again`. A module-level "running" flag stops double calls inside one mount (StrictMode); main's one-shot is the real guard. Reports trusted `pointerdown` for the MCP hold (4.8). |
| `src/App.tsx` | The vault init effect (`:438-510`) calls `runStartupVault()` once auth settles (4.1). The team auto-connect block moves into `runStartupVault` unchanged, with the vault id from the plan. `FullScreenSpinner` (`:114-123`) gets `role="status"` on the text and an optional autofocused action for "Go to Vault Hub". `AuthScreen` and onboarding report focus to main (4.5). The `vault-locked-by-system` listener (`:856-863`) is unchanged; new `vault-startup-again` and `auto-unlock-forgotten` listeners. |
| `src/components/vault/UnlockDialog.tsx` | The checkbox (hidden while Touch ID runs), the status line after a lock, the stale and unreadable callouts, the `"saved"` attempt kind, "Try Again", no Touch ID auto-start in a fallback, Cancel on a gate dialog closes the whole dialog for kind `"saved"`, and the swap to `AutoUnlockWarningDialog` after success. The file is 322 lines [V]; the new state moves into a hook `useAutoUnlockChoice.ts` to keep it under 400. |
| `src/components/sync/PasswordChangedElsewhereDialog.tsx` | A `fromSavedUnlock` prop: hides the previous-password field, adds the line and the keep checkbox (3.6). |
| `src/components/vault/AutoUnlockWarningDialog.tsx` (new) | 2.2. |
| `src/components/vault/recentVaultMenu.ts` (new) | Builds and runs the recent-vault context menu for the Hub, the vault menu and the Startup badge. |
| `src/components/vault/VaultHub.tsx` | Uses `recentVaultMenu`; the "Startup" badge button and `lockOpen` icon with `sr-only` text; a context menu on team rows; the Clear All confirm; `handleRetryAutoConnect` reads the startup choice. |
| `src/components/vault/VaultSwitcherMenu.tsx` | Uses `recentVaultMenu`; `lockOpen` icon on the current row. |
| `src/components/layout/Sidebar.tsx` | `lockOpen` icon, title text and `sr-only` text on the switcher button (`:314-323`). |
| `src/components/settings/tabs/GeneralTab.tsx` | Renders `StartupVaultSetting`. |
| `src/components/settings/tabs/StartupVaultSetting.tsx` (new) | 2.4. |
| `src/components/settings/tabs/SecurityTab.tsx` | `NoticeCard` gains an `icon` prop; renders `AutoUnlockSetting` between the two existing sections. |
| `src/components/settings/tabs/AutoUnlockSetting.tsx` (new) | 2.5. |

### 6.3 Docs and harness

| File | Change |
|---|---|
| `docs/FEATURES.md` | Section 7.1, plus the System Tray line at `:840` (7.1). |
| `docs/MULTI_DEVICE_SYNC.md` | `:546` unlock policy: add "a saved automatic-unlock password that fails is deleted and the user is asked". `:823` list of unlock paths: add `auto_unlock` (ten paths). `:754` note that automatic unlock is keyed by lineage only. |
| `docs/PLAN_ENFORCEMENT.md` | Near `:1615`: the own-copy ticket works for the `auto_unlock` source too. |
| `release-notes/manifest.json` | Section 7.2, in the next version's entry. |
| `scripts/verify/suites/startup.mjs` (new), `scripts/verify/lib/startup-flows.mjs` (new) | Section 8.2. |
| `scripts/verify/README.md`, `package.json` (`verify:startup`), `.claude/skills/verify-data` | List the new suite. |

---

## 7. FEATURES.md and What's New

### 7.1 FEATURES.md

New section after "Quick Unlock (Biometric)" (`docs/FEATURES.md:196-213`) [V]:

```markdown
### Startup Vault and Automatic Unlock
- **Open at startup** (Settings > General): show the Vault Hub, one personal vault or one team vault when Conduit starts. "Last team vault used" (team members) keeps the old rule: reconnect to the last team vault used
- A personal startup vault goes straight to its unlock prompt; Touch ID starts by itself when Quick Unlock is on
- **Unlock automatically at startup** (checkbox in the unlock dialog, or Settings > Security): the startup vault opens with no password
  - Turning it on needs the master password or Touch ID at that moment and shows a warning first
  - The master password is sealed with the operating system's secret store (macOS Keychain, Windows DPAPI, GNOME Keyring or KWallet on Linux), keyed by vault identity (lineage) and tied to the Conduit account that turned it on; never in settings.json. The folder is `{dataDir}/auto-unlock/` on macOS and Linux (excluded from Time Machine) and under `%LOCALAPPDATA%` on Windows (never roams)
  - Not offered, and never re-saved, when the secret store is missing, or on Linux without a real keyring (`basic_text`)
  - At most one vault per computer: choosing another startup vault turns it off for the old one
  - Runs once per start, and when the window opens again after being closed while an automatically opened vault was open; after Lock, the idle lock or the screen lock, the password or Touch ID is needed until Conduit starts again
  - Never takes over: every device limit, ownership, sign-in and update check shows its normal dialog; Cancel there goes to the Vault Hub
  - A saved password that no longer works (changed on another device) is deleted at once; the normal prompt shows with a note and a checkbox to save the new one
  - Re-saved after a password change on this device or learned through sync; follows renames and moves
  - Turned off by Remove from Recents, Clear All, Sign Out, any change of signed-in account, releasing the vault and Make my own copy (the copy becomes the startup vault)
  - After an automatic unlock, MCP calls get the locked error until you click or type in Conduit
  - A small open-lock icon beside the vault name while it is on, a short toast after each automatic open, and a "Startup" badge with the same icon in the Vault Hub
  - Hold Shift (or Option on a Mac) as Conduit starts, click "Go to Vault Hub" on the opening screen, or start with `--no-startup-vault` to skip it once
  - All plans; desktop only. Uninstalling Conduit leaves the data folder, and the sealed entry, in place
```

(The MCP line depends on owner decision 10.7.)

Settings list (`docs/FEATURES.md:644-646`) [V]:

```markdown
### General
- Open at startup (see Startup Vault and Automatic Unlock)

### Security
- Quick Unlock toggle (macOS)
- Automatic unlock at startup, with its warning (see Startup Vault and Automatic Unlock)
- "Lock the vault when idle" (off by default; see Auto-Lock)
```

System Tray line (`docs/FEATURES.md:840`) [V], replace "Reopening from the dock, tray, or a second-instance launch requires vault re-unlock." with:

```markdown
Reopening from the dock, tray, or a second-instance launch requires vault re-unlock, except that a vault set to unlock automatically opens again by itself when it had opened automatically and was not locked before the window closed.
```

### 7.2 What's New

One highlight in the next version's entry of `release-notes/manifest.json` (format: `src/types/whats-new.ts`) [V]:

```json
{
  "text": "**Open your vault when Conduit starts**: pick a vault in Settings > General and Conduit opens it instead of the Vault Hub. You can also let this computer unlock it for you: Conduit keeps the master password in your system keychain and shows a clear warning first. Hold Shift while Conduit starts to skip it once.",
  "category": "feature"
}
```

---

## 8. Tests

### 8.1 Unit tests (vitest; `npx vitest run`)

| File | Cases |
|---|---|
| `electron/services/vault/__tests__/auto-unlock-store.test.ts` (new) | Seal and read round trip with a fake `safeStorage`; the file is 0600 and the folder 0700 (POSIX); the write is atomic (a failed rename leaves the old file); sealing B removes A; `removeAllExcept`; unknown `v`, lineage mismatch and backend mismatch read as `unreadable` and keep the file; decrypt throws: `unreadable`, file kept; status: macOS/Windows by `isEncryptionAvailable`, Linux refuses `basic_text` and `unknown` and accepts the four keyring backends; the status is read on every call; **re-seal under `basic_text` writes nothing and removes the old entry**; `secretDir` uses `LOCALAPPDATA` on win32; the Time Machine exclusion runs on darwin and its failure does not block the seal. |
| `electron/services/vault/__tests__/startup-modifiers.test.ts` (new) | Flag parsing (Shift, Option, both, none); probe timeout and error mean "not held"; the probe runs once; the input collector counts `shift`, and `alt` only on darwin; **it ignores events after 1.5 s and after a focus report (Shift+letter typed on the auth screen does not skip)**; the switch. |
| `electron/ipc/__tests__/startup-vault.test.ts` (new) | Every plan branch of 4.2 (a to f), including a `conduit://` launch giving `auto: false`; the one-shot (second call `none`); **re-arm only when the close lock closed an automatically opened vault with no lock since; Lock then close then show does not re-arm; a second instance with a URL or file never re-arms**; attempt lifetime (success, cancel, lock, other vault, 10 min) and the saved password dropped at `done`; file association wins; lineage mismatch gives `auto: false`; settings validation; `withStartupPathMoved` and `withStartupCleared` are pure. |
| `electron/ipc/__tests__/auto-unlock.test.ts` (new) | Mocks as in `biometric-unlock.test.ts:9-45` [V per fact sheet]. First try forces `takeover: false` even if asked; a retry may take over only in state `open`; **INVALID and `CHANGED_ELSEWHERE` delete the file and return the stale fallback**; a `"saved"` retry fills `previousPassword` from the attempt; **account check: auth not initialized, or user id different, deletes the entry and returns `account`**; each structured gate error reaches the renderer unchanged; the source is `auto_unlock`; no handler result contains the password; the three proofs (recent unlock within 120 s, never after `auto_unlock`; password compare; Touch ID); enable sets the startup vault, seals the user id and removes other entries. |
| `electron/ipc/__tests__/auto-unlock-lifecycle.test.ts` (new) | Any user id change (A to null, A to B, null to A) forgets all entries and sends the event once. |
| `electron/ipc-server/__tests__/mcp-hold.test.ts` (new) | While held, vault requests get the locked response; a key press or trusted pointer report clears it; a typed unlock never sets it. |
| `electron/__tests__/deep-link-logging.test.ts` (new) | The deep-link path and `handleDeepLinkTokens` log no token values or URL fragment. |
| `electron/ipc/__tests__/recent-vaults.test.ts` | Remove and Clear also forget and clear the startup vault, and report what they changed. |
| `electron/ipc/__tests__/sign-out-flow.test.ts` | Sign-out forgets every entry; a failure is logged and never blocks sign-out. |
| `electron/ipc/__tests__/sync-password.test.ts`, a new `vault-manage-autounlock.test.ts` | Re-seal after both kinds of password change, including the private-vault lineage move; no entry when it was off before. |
| `electron/ipc/__tests__/vault-lock-flow.test.ts` | Any lock ends the startup attempt; `lockVaultFromMain` returns whether it closed a vault. |
| `src/components/vault/__tests__/UnlockDialog.autounlock.test.tsx` (new) | Checkbox shown only when usable, personal, not on, not take-over and no Touch ID running; it appears after Touch ID is cancelled; checked + success shows the warning; Cancel keeps the vault open and seals nothing; the status line after a lock; stale and unreadable callouts and the pre-checked box; **no Touch ID auto-start in a fallback**; **Cancel on a gate dialog with kind `"saved"` closes the dialog and shows the Hub toast, while a typed attempt keeps today's behavior**; the `"saved"` retry repeats the kind after take-over; StrictMode mounts call `vault_auto_unlock` once (see `UnlockDialog.strict.test.tsx`). |
| `src/components/sync/__tests__/PasswordChangedElsewhereDialog.test.tsx` | With `fromSavedUnlock`: no previous-password field, the added line, the checkbox checked by default. |
| `src/components/vault/__tests__/AutoUnlockWarningDialog.test.tsx` (new) | Exact warning text; the replacement line for each prior choice; password field only from Settings; wrong password message; "Use Touch ID Instead" only on macOS with Touch ID. |
| `src/components/vault/__tests__/VaultHub.test.tsx` | Badge button and icon (with `sr-only` text); menu items and their IPC calls; team row menu; Clear All confirms only when a saved unlock exists; toasts after Remove and Clear All. |
| `src/components/settings/__tests__/StartupVaultSetting.test.tsx`, `AutoUnlockSetting.test.tsx` (new) | Options per user type and the "Last team vault used" label; the confirm when a saved unlock exists; every Security state row of 2.5; the NoticeCard shows the lock icon. |
| `src/components/settings/__tests__/settings-merge.test.ts` | Saving other settings never overwrites `startup_vault` written by IPC. |
| `src/lib/__tests__/startup-vault.test.ts` (new) | Waits for auth; runs nothing behind the auth screen or onboarding; each plan kind leads to the right screen and toast; the opening screen's button has focus and the text has `role="status"`; the team startup vault shows the button, "Last team vault used" does not. |

### 8.2 Live verify scenarios (new suite `startup`)

Run only this suite: `node scripts/verify/run.mjs startup` (or `--only <id>` for one scenario; `scripts/verify/run.mjs:37-55`) [V]. Devices run in quiet mode by default (`scripts/verify/lib/launcher.mjs:101-133`) [V], so nothing takes focus. Local Supabase is shared: the suite creates its own users and never resets or stops it. Modeled on `idleAutoLock` (`scripts/verify/suites/lifecycle.mjs:283-326`) [V], using `ctx.quitDevice`, `ctx.launchDevice(id, { args })`, `waitForScreen`, `readDeviceSettings`. The suite runs after the token logging fix (6.0), since it reads main logs. Also run `lifecycle` (lock and idle lock paths change).

| Id | Steps and checks |
|---|---|
| `auto-unlock-relaunch` | Pro user. Create a vault, lock, unlock with the checkbox, accept the warning. Check `settings.startup_vault` and one file in `auto-unlock/`. Quit, relaunch: no Hub, `vault_is_unlocked` true, lease active, the sidebar icon present, the "unlocked automatically" toast, main log `source: 'auto_unlock'`. **Runs first: it checks the [A] that the mock keychain survives a relaunch.** |
| `lock-asks-again` | After an automatic start: Lock, the Hub shows, clicking the vault shows the unlock dialog (no automatic open) with the "runs when Conduit starts" status line. Close the window and show it again: still the Hub, no automatic open. Idle lock via `stubSystemIdle` (`lib/lifecycle-flows.mjs`) gives the same. Fresh relaunch, then close and show with no lock in between: the vault opens by itself. |
| `escape-hatch` | Relaunch with `args: ['--no-startup-vault']`: Hub, vault locked, toast "Startup vault skipped", setting unchanged. |
| `go-to-hub` | Stall the open (block the peek with the existing net proxy, `lib/net-proxy.mjs`), click "Go to Vault Hub": Hub, vault locked, no lease left. |
| `stale-after-change-elsewhere` | Pro pair A and B. B changes the password. Relaunch A: the password-changed dialog in its saved form shows (no previous-password field), never a second automatic try (main log has one `auto_unlock` attempt), and `auto-unlock/` is already empty. Enter the new password with the box checked: unlocked, one file again; relaunch: automatic again. |
| `free-open-elsewhere` | Free user, vault open on B. Relaunch A: the take-over dialog shows; B keeps its lease (no automatic take-over). Cancel: the Hub with the "didn't open" toast, not a password form. |
| `missing-file` | Move the vault file away, relaunch: Hub, toast "Couldn't find ..." with both actions, setting kept. Move it back, relaunch: automatic. |
| `startup-without-auto` | Startup vault set from the Hub menu, no automatic unlock. Relaunch: the unlock dialog shows at once. |
| `sign-out-forgets` | Sign out: `auto-unlock/` empty. Sign in, relaunch: the unlock dialog, not automatic. |
| `account-switch-forgets` | With a saved unlock for user A, sign in as user B through the harness (same path as a deep link): `auto-unlock/` empty; relaunch: the unlock dialog, not automatic. |
| `mcp-after-auto-unlock` | After an automatic relaunch, an MCP `entry_list` call through `lib/mcp.mjs` returns the locked error; after one synthetic key press in the window it succeeds; after Lock it returns the locked error again. (Only when owner decision 10.7 keeps the hold; otherwise it succeeds at once.) |
| `team-startup` | Team user sets a team vault as startup; relaunch: the team vault opens; the opening screen had the "Go to Vault Hub" button. |

Not covered live: holding Shift or Option (quiet devices never take keyboard focus), real Keychain, DPAPI and keyring prompts, Linux backends, Windows roaming, Time Machine, fuses. These are manual checks (section 9).

---

## 9. Assumptions to test

| # | Assumption | How to check |
|---|---|---|
| 1 | The mock keychain (`--use-mock-keychain`) keeps the same key across a quit and relaunch, so a sealed file survives. | First step of `auto-unlock-relaunch`. If it fails, the live suite seeds the entry through a test-only IPC under the harness launcher. |
| 2 | `NSEvent.modifierFlags` from `osascript` reports a key held by the user, with no permission prompt. | Manual: hold Shift, run the command; hold Option; start the packaged app holding each. |
| 3 | Windows repeats a held Shift key to the new focused window within 1.5 s of show, so `before-input-event` sees it. | Manual on Windows. If not, add a PowerShell `[System.Windows.Forms.Control]::ModifierKeys` probe at `whenReady`. |
| 4 | Linux `basic_text` is plain text in effect, and the four keyring backends bind the entry to the login. | Chromium docs and a manual check on GNOME and KDE. |
| 5 | With the 6.0 fuses set, another program cannot run Conduit's signed binary with a debugger or preload, and so cannot read the Keychain item with no prompt. With `RunAsNode` still on, it may still load its own native code under Conduit's signature. | Manual with a signed build: try `--inspect`, `NODE_OPTIONS=--require`, and `ELECTRON_RUN_AS_NODE=1` with a native addon. |
| 6 | A private vault that becomes shared may change lineage, so the entry is not found. | Unit test in the sync lineage code, or a live step. |
| 7 | An app update with a new signature can trigger a macOS Keychain prompt at startup. | Manual with a signed build pair. |
| 8 | The data folder (and the entry) stays after uninstall. | Manual per platform; documented only. |
| 9 | On Windows, `app.getPath('appData')` and `sessionData` are Roaming, `%LOCALAPPDATA%` does not roam, and DPAPI keys follow a roaming profile. | Electron docs; manual on a domain PC if one is available. |
| 10 | Time Machine and Migration Assistant carry the login keychain, and `tmutil addexclusion` keeps the folder out. | Manual on macOS: `tmutil isexcluded` on the folder. |
| 11 | `utilityProcess` can stand in for the Claude Code SDK's spawn hook, so `RunAsNode` can be turned off. | Read the SDK's spawn contract; spike. |

---

## 10. Decisions for the owner

1. **One saved vault per computer, tied to the startup vault** (1.2 item 1) instead of a separate per-vault switch. Simpler and less exposure. The cost: a saved unlock is never used for Hub clicks.
2. **Closing the window and reopening it counts as a start** (4.6), but only when the vault had opened automatically and was not locked since. Lock, idle lock and screen lock still ask for the password, even across a close and reopen.
3. **Sign Out and any account change forget every saved unlock** on this computer, including a forced sign-out.
4. **"Last team vault used"** keeps today's team behavior as the default for team members.
5. **The unlock dialog checkbox** is the main way in, plus Settings. The Hub menu can only turn it off.
6. **Seal the password, not a key.** Recommended for now: same as Quick Unlock, and a key-only open is a large change. The cost: a leaked entry also opens every local and cloud backup, the vault on other devices, and any reused site (3.1). Moving both features to a key is the follow-up.
7. **MCP waits for a person after an automatic unlock** (4.8). Recommended: on. Without it, any program on the computer can launch Conduit and read every password. The cost: an agent that runs with nobody at the computer cannot use the vault until someone clicks or types in Conduit.
8. **A toast after each automatic open** (2.7). Recommended: on, because the sidebar icon is often hidden. Drop it if it feels noisy.
9. **Ship on macOS before `RunAsNode` is off?** The other fuses (6.0) are a prerequisite either way. With `RunAsNode` on, the macOS store stays open to other programs, the same as Windows and Linux. Recommended: ship with the other fuses and state it, then move the Claude Code spawn off `RunAsNode`.

---

## 11. Review notes

A code review raised 23 findings on the first draft. Each was checked against the code at b072690. All 23 were real; the spec above is revised for each. Parts of three suggested fixes were not taken:

| Finding | Verdict | What changed or why not |
|---|---|---|
| Fuses: any program can run the signed binary with `--inspect` / `NODE_OPTIONS` and read the Keychain | Confirmed (fuse read on `/Applications/Conduit.app`, entitlements, `claude-code-engine.ts:541-552`) | 5.2 rewritten; 6.0 prerequisite; assumption 9.5 replaced. **Not taken:** "move the SDK spawn to `utilityProcess.fork`" as a fixed plan. The SDK spawn hook expects a `ChildProcess` and that is unverified, so it is assumption 9.11 and owner decision 10.9. |
| Any program can launch Conduit and read passwords over MCP | Confirmed (`server.ts:2050-2056`, `:285-310`; approval only in the MCP process) | 4.8 hold, new 5.2 row, warning widened, decision 10.7. |
| Lock, close, reopen re-arms | Confirmed (`main.ts:758-778`, `vault.ts:22-24`) | 4.6 flag rule; `lockVaultFromMain` returns a boolean; second instance with URL or file never re-arms. |
| Saved unlock not tied to the account | Confirmed (`main.ts:106-127`, `state.ts:263-272`) | `userId` in the envelope; main-side account check; forget on any user id change; no auto-unlock on a `conduit://` launch. |
| Re-seal skips the weak-backend check | Confirmed as a spec gap (`biometric.ts:208-210` checks only availability) | 3.2: status read fresh; every seal checks; backend in the envelope; test. |
| Windows Roaming, macOS migration | Confirmed for the path (`app-identity.ts:17`); platform behavior is [A] | 3.3 location and exclusion; 3.7 rows; 5.2 row. **Not taken:** `app.getPath('sessionData')` as the Local path: it defaults to `userData`, which is Roaming too. Uses `process.env.LOCALAPPDATA`. |
| The password reaches further than the key | Confirmed (`local-backup-crypto.ts:54,104`) | 3.1, 5.3, decision 10.6. |
| Stale password kept after Cancel | Confirmed (`open-password.ts:65` for Quick Unlock) | Deleted at once on INVALID and `CHANGED_ELSEWHERE`; kept only when unreadable. |
| Compromised renderer verdict "Safe" | Confirmed (`biometric.ts` IPC `:66-72`) | Verdict changed to "Not protected". **Not taken:** moving consent to a native `dialog.showMessageBox` in main. A compromised renderer already reads typed passwords, so a native box would add friction and a second visual style for little gain. |
| Token material in logs | Confirmed (`main.ts:94`, `supabase.ts:507`, logger `:118-128`) | 6.0 prerequisite and test. |
| Shift typed on the sign-in screen skips | Confirmed (`App.tsx:984-996`) | 4.5: one probe at `whenReady`; 1.5 s collector with early stop; test. |
| Touch ID auto-starts over a fallback | Confirmed (`UnlockDialog.tsx:77-89`) | 2.1 and 4.4: no auto-start in a fallback; test. |
| Cancel on a gate dialog drops to the password form | Confirmed (`UnlockDialog.tsx:147-151`, `UnlockErrorView.tsx`) | 2.1: kind `"saved"` closes the whole dialog; live `free-open-elsewhere` now matches. |
| Password-changed dialog asks for the saved password | Confirmed (`PasswordChangedElsewhereDialog.tsx:34-63`, `open-password.ts:95-99`) | 3.6: main supplies it; field hidden; line and checkbox added. |
| Settings unreachable from the Hub | Confirmed (`App.tsx:1000-1060` vs `:1119`) | Toast actions "Stop Opening at Startup"; Startup badge opens the menu; the unreachable Security state dropped. |
| Close-and-reopen not in the warning or FEATURES | Confirmed (`FEATURES.md:840`) | Short warning reworded; FEATURES line added (7.1). |
| Checkbox useless with Touch ID auto-start | Confirmed (`UnlockDialog.tsx:77-106`) | 2.1: shown only after Touch ID is cancelled or fails; Settings for the rest. |
| Remove / Clear All lose the setting silently | Confirmed (`VaultHub.tsx:262-263`, `:124-128`) | 2.6 confirm and toasts; 2.8 rows. |
| Indicator often hidden, `title` only | Confirmed (`sidebarStore.ts:97`, `Sidebar.tsx:314-323`) | `sr-only` text; Security named as the always-reachable place; per-start toast (decision 10.8). |
| "Automatic" wording and missing replacement lines | Confirmed | "Last team vault used"; replacement line for every prior choice. |
| Opening screen accessibility; no cancel for a chosen team vault | Confirmed (`App.tsx:114-123, 999-1001`) | 2.3: `role="status"`, autofocused button, button for a chosen team vault. |
| `NoticeCard` always shows a fingerprint | Confirmed (`SecurityTab.tsx:117-123`) | `icon` prop. |
| No word about automatic unlock after a lock | Confirmed (`UnlockDialog.tsx:257-265`) | 2.1 status line. |

---

## 12. Build notes

Where the implementation differs from the text above, and why:

- **Fuses** are set with electron-builder's own `electronFuses` in `electron-builder.yml` instead of `scripts/afterPack.cjs`: electron-builder flips them right before signing, which is the order the fuses need. `disable-library-validation` stays in the entitlements until a signed build shows nothing (FreeRDP helper dylibs, native modules) needs it.
- **Stale saved password on a synced vault.** When this device still has its working copy, the old password opens that copy and sync pauses with "Syncing paused"; entering the new password there re-seals the saved unlock (3.6). The stale prompt of 2.1 shows when the old password opens nothing (for example without a working copy). The live scenario `stale-after-change-elsewhere` removes the working copy to reach it; the password-changed dialog in its saved form is covered by unit tests.
- **A saved unlock counts only while its vault is at the path.** The Hub, Settings and the unlock dialog treat the startup vault as having a saved unlock only when the file at the path still has the saved lineage (3.7 "Another vault now at the startup path"), so they never claim automatic unlock for another file.
- **The Startup badge** is a plain badge inside the row: the row is already a button, so a button inside it would nest. The row's context menu opens from the keyboard with Shift+F10 or the context menu key.
- **Clear All / Remove** return the recent list as before; the renderer derives the toasts from the startup status it already holds.
- **Idle lock payload.** `vault-locked-by-system` carries `{ reason: 'idle' | 'lock-screen' | 'window-closed' }`. The close handler still tells the renderer when a team vault is open, as before.
- **Time Machine.** `tmutil addexclusion` can be refused for an app without Full Disk Access; the store then sets the `com.apple.metadata:com_apple_backup_excludeItem` attribute itself.
- **One toast controller.** App renders one `NotificationStack` for every screen, so a toast raised on the opening screen or the Hub survives the switch to the main window.
- **Live coverage.** `lock-asks-again` uses the screen lock (the idle lock's code path) instead of waiting for the idle timer. Shift and Option at launch, Windows, Linux backends and the fuses remain manual checks (section 9).

