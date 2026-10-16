# Beta channel

Betas let real users try new features before a regular release. A beta is the same Conduit app with a version like `0.19.0-beta.1`. There is no separate beta app.

Beta builds use **production**: the normal sign-in, plan, vaults, sync and team data. Ship a beta only when its backend changes are live in production.

## For users

### Join

Either of these works:

- **Settings > General > Updates**: turn on **Get beta updates**. Conduit checks right away and downloads the newest beta, if one is newer than the version you have.
- **Install a pre-release** from [GitHub Releases](https://github.com/advenimus/conduit-desktop/releases). A beta build turns beta updates on by itself, so you keep getting betas until you turn the switch off.

### Leave

Turn off **Get beta updates**. Conduit never moves you to an older version. You stay on the beta you have and move to the next regular release when it comes out. Settings says so under the switch.

If a newer beta is downloading or waiting to install when you turn the switch off, Conduit drops it. It does not install on quit, and the restart prompt and the Help menu's **Restart to Update** go away. On macOS, a beta that had already finished downloading can still install on the next quit (see the gap below).

### Telling a beta apart

- The version ends in `-beta.N` in Settings and the About dialog.
- A small **Beta** pill shows in the title bar and the About dialog. Click it to send feedback.
- What's New does not open by itself after a beta update, unless that beta has its own release notes entry.

## How it works

| Piece | Where |
|---|---|
| Setting `beta_updates` (`undefined` = follow the running version) | `electron/ipc/settings.ts` |
| Channel logic (`isPrereleaseVersion`, `getEffectiveBetaUpdates`, `applyUpdateChannel`) | `electron/services/update-channel.ts` |
| IPC `updater_get_channel`, `updater_set_beta_updates` | `electron/ipc/updater.ts` |
| Dropping a pending beta when betas turn off (`createPendingUpdateGate`) | `electron/services/pending-update.ts` |
| Settings UI | `src/components/settings/tabs/UpdatesSetting.tsx` |
| Beta pill | `src/components/common/BetaPill.tsx` |

- The effective value is the saved setting, or, when nothing is saved, whether the running version has a prerelease part.
- Before every check, the updater sets `allowPrerelease` to the effective value and `allowDowngrade` to `false`. Both are set every time because electron-updater turns `allowPrerelease` on by itself for a beta build.
- We never set the updater's `channel`. Setting it also allows downgrades and makes the updater look for `beta-*.yml` files.
- With `allowPrerelease` on, electron-updater reads the GitHub releases feed and takes the newest release, beta or regular. With it off, it takes the latest regular release.
- Beta builds publish the usual `latest*.yml` files (the GitHub publisher does not split channels). The updater first asks for `beta*.yml`, gets a 404, then falls back to `latest*.yml`.
- Version order follows semver: `0.19.0-beta.1` < `0.19.0-beta.2` < `0.19.0`. So beta users get the regular `0.19.0` automatically.
- Turning the switch saves the setting, applies it, clears the cached result and runs a fresh check. It is not part of the Settings Save button.

### Turning betas off with a beta pending

electron-updater downloads on its own (`autoDownload`) and installs on quit (`autoInstallOnAppQuit`). The pending update gate stops a beta once the switch is off. It reads the setting fresh at every step, so it also catches a switch turned on and then off while a check is still running.

- **Check finds a beta after the switch went off**: the download is cancelled through the check's cancellation token and nothing is shown.
- **Beta still downloading when the switch goes off**: same, the download is cancelled.
- **Beta finishes downloading after the switch went off**: `autoInstallOnAppQuit` is set to `false` inside the `update-downloaded` event, before electron-updater reads it. On Windows and Linux the quit handler reads it at quit. On macOS the file is never handed to Squirrel.Mac.
- **Beta already downloaded**: `autoInstallOnAppQuit` goes to `false` and the downloaded version is forgotten.
- In every case the main process sends `update:cleared` (the update overlay hides) and rebuilds the Help menu. `install_update` and `download_and_install_update` refuse a beta while betas are off.
- The next regular update that downloads sets `autoInstallOnAppQuit` back to `true`.
- A cancelled download also empties electron-updater's pending folder, so the follow-up check downloads any regular update again.
- Remaining gap, macOS only: once a beta has fully downloaded with betas on, electron-updater hands it to Squirrel.Mac. Squirrel installs a staged update on the next quit and has no way to take it back, so turning betas off after that point does not stop it.

## Cutting a beta

1. Bump `package.json` to `X.Y.Z-beta.N` (for example `0.19.0-beta.1`).
2. Write `docs/releases/vX.Y.Z-beta.N.md` (format in `docs/releases/README.md`).
3. Optional: add a `release-notes/manifest.json` entry with the exact beta version if What's New should open for it.
4. Merge to `main`.
5. Tag `vX.Y.Z-beta.N` and push the tag.

The release workflow fails early if the tag is not exactly `v` + the `package.json` version. Tags containing `beta`, `alpha` or `rc` become GitHub pre-releases, so they never show as "latest" on GitHub.

To promote a beta, bump to `X.Y.Z`, write `docs/releases/vX.Y.Z.md` and release as usual.

## Testing in development

`npm run dev:electron` uses `dev-app-update.yml`, which points at the real GitHub releases. Checking for updates there only reads; it publishes nothing. To see a beta build's behavior, set the version in `package.json` to a beta locally (do not commit it), then check the Beta pill, the About dialog, Settings > General > Updates and What's New.
