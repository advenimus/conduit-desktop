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
