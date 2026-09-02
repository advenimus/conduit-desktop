# Dependency Upgrades — Tier 3 (Major Versions)

Last updated: 2026-03-03

## Overview

Major dependency upgrades to resolve remaining moderate vulnerabilities and modernize the stack.
**Result: 6 moderate vulnerabilities → 0 vulnerabilities.**

| Phase | Package(s) | From | To | Status |
|-------|-----------|------|-----|--------|
| 1 | xterm → @xterm/xterm, mcp/uuid | 5.x / 9.x | 6.0.0 / 11.x | Done |
| 2 | vite, @vitejs/plugin-react | 5.x / 4.x | 7.3.1 / 5.1.4 | Done |
| 3 | vitest | 2.x | 4.x | Done |
| 4 | react, react-dom, @types/react* | 18.x | 19.x | Done |
| 5 | eslint, typescript-eslint | 8.x / 7.x | 10.0.2 / 8.56.1 | Done |
| 6 | electron | 34.x | 35.7.5 | Done |

## Verification Gate (after each phase)

1. `npx tsc --noEmit` + `npx tsc -p electron/tsconfig.json --noEmit`
2. `npx vitest run`
3. `npm run dev:electron` (smoke test)
4. Commit as rollback point

## Phase Details

### Phase 1: xterm rename + MCP uuid

- Replace `xterm` with `@xterm/xterm` (package rename, same API)
- Update CSS import paths from `xterm/css/xterm.css` to `@xterm/xterm/css/xterm.css`
- Update `ITheme` import from `xterm` to `@xterm/xterm`
- Upgrade `mcp/uuid` from 9.x to latest (import pattern unchanged)

### Phase 2: Vite 5 → 7 + plugin-react 4 → 5

- Explicit `build.target` in vite.config.ts overrides new defaults
- No breaking config changes expected

### Phase 3: Vitest 2 → 4

- Requires Vite >= 6 (Phase 2 prerequisite)
- Standard `defineConfig` from `vitest/config` — no breaking changes expected

### Phase 4: React 18 → 19

- Run `types-react-codemod preset-19` for useRef type changes
- No `forwardRef`, `defaultProps`, `propTypes`, or `ReactDOM.render` usage
- Compatible deps: react-markdown@10, zustand@5, @testing-library/react@16

### Phase 5: ESLint 8 → 10 (flat config)

- Create `eslint.config.js` (new flat config format)
- Replace `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` with `typescript-eslint`
- Update lint script in package.json
- Zero runtime risk — only affects linting

### Phase 6: Electron 34 → 35

- Fix `console-message` event signature in `electron/ipc/menu.ts`
- Rebuild native modules: better-sqlite3, node-pty, koffi, ssh2, sharp
- Full production build verification required

## Rollback

Each phase is committed separately. To rollback any phase:
```bash
git revert <commit-hash>
npm install
```

---

## Upgrading Electron — macOS Local Network Permission

**Electron is pinned to an exact version in `package.json` on purpose. Do not restore the caret range.**

macOS identifies an app for the Local Network permission partly by a fingerprint (`LC_UUID`) baked into the main executable at `Contents/MacOS/Conduit`. That executable is the prebuilt Electron launcher stub — electron-builder only copies, renames, and signs it, and signing cannot alter the fingerprint. Every app built from the same Electron version therefore ships the same stock UUID.

`scripts/afterPack.cjs` rewrites that UUID to a value derived from `com.conduit.app` before electron-builder signs, and `scripts/stamp-electron-dev.cjs` does the same for the npm Electron.app using `com.conduit.app.dev`. The grant then follows Conduit (or Conduit Dev), not the Electron version.

Verified: Electron `41.0.3` produces `4C4C4450-5555-3144-A175-A5A5EB513DF3`; Electron `41.10.4` produces `4C4C4461-5555-3144-A1D9-15C795D7EB04`. Without the rewrite, a patch-level Electron bump is enough to change the identity.

When the fingerprint changes, macOS can treat the build as a different program. The app disappears from System Settings › Privacy & Security › Local Network, and there is no supported way to reset that permission or put the entry back by hand.

### Why the caret was dangerous

`^41.0.3` let any unrelated `npm install` float the resolved version inside the lockfile. Because CI runs `npm ci`, whatever the lockfile says is what ships. That turned "someone bumped an unrelated dependency" into "every macOS user must re-grant local network access" — with no one intending it.

### Procedure for an intentional Electron upgrade

1. Change the exact version in `package.json`, run `npm install`, and confirm the lockfile moved.
2. Confirm the fingerprint actually changed, so you know a re-prompt is expected:
   ```bash
   dwarfdump --uuid node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
   ```
3. Ship the Electron bump **on its own**, never bundled with changes to local network handling — otherwise a failure cannot be attributed.
4. Verify recovery on a **fresh macOS user account** (the permission is stored per user, so a new account is the only clean slate — see below). Install, launch, and confirm the consent alert appears and Conduit lands back in the Local Network list.
5. Call it out in the release notes: macOS will ask for local network access again.

### Why a fresh user account is the only test

Apple provides no way to reset this permission to undetermined on macOS (FB14944392). `tccutil reset LocalNetwork` does nothing, because the grant is not stored in TCC at all — it lives in Network Extension path rules under `/Library/Preferences/com.apple.networkextension*.plist`. A new user account, or a VM snapshot, is the only supported clean slate.

### What the app already does

`electron/services/local-network.ts` requests the permission on every macOS launch, so a build whose identity changed asks again at startup instead of failing silently on the user's first connection. That is the recovery path an Electron upgrade depends on — keep it working.

### Open question

Whether macOS keys this permission on `LC_UUID` or on the code signature hash (`cdhash`) is not documented publicly. The cdhash changes on **every** Conduit release, because version strings and asar integrity hashes feed into it. If cdhash is the key, every release is an identity change and pinning Electron only reduces the problem rather than removing it. The afterPack UUID rewrite removes the Electron-version collision; treat the launch-time request as the load-bearing mitigation either way.
