# Contributing to Conduit

Thanks for your interest in Conduit. This repo is the Apache 2.0 client — the
Electron desktop app, protocol handlers (SSH/RDP/VNC/Web), FreeRDP helper, and
the MCP server that AI agents connect to. Cloud sync, team vaults, billing, and
the backend API live in a separate proprietary repo.

## What we accept

| Welcome | Discuss first |
|---|---|
| Bug fixes | Large refactors |
| New MCP tools with clear use cases | Major architectural changes |
| Protocol fixes (SSH/RDP/VNC/Web) | New connection protocols |
| Docs, typo fixes, examples | Changes to tier enforcement, auth flow |
| Accessibility improvements | Third-party backends / hosted clones |

For anything in the "discuss first" column, open an issue describing your
proposal before starting work.

## Getting set up

Prerequisites:
- Node 20+
- Docker Desktop (for local Supabase)
- macOS: Xcode Command Line Tools. Windows: Visual Studio Build Tools 2022. Linux: build-essential + GTK3.
- Apple Developer ID if you want to produce signed macOS builds (optional; ad-hoc signing works for local development)

```bash
git clone https://github.com/advenimus/conduit-desktop.git
cd conduit-desktop
npm install

# Start local Supabase for auth/tier data:
supabase start

# Run the desktop app:
npm run dev:electron
```

See `docs/LOCAL_SUPABASE.md` for the full local-backend setup.

## Repo layout

```
electron/            Electron main process (TypeScript)
  ipc/               IPC handlers registered with ipcMain
  services/          Domain services (vault, ssh, rdp, vnc, web, ai engines)
  ipc-server/        Unix socket server used by the MCP binary
mcp/                 Standalone MCP server (Node, TypeScript)
  src/tools/         One file per tool category
src/                 React renderer (Vite)
  components/        UI
  stores/            Zustand state
freerdp-helper/      FreeRDP C helper binary + build scripts
supabase/            Local Supabase schema + migrations
```

## Pull request checklist

Before opening a PR:

- [ ] `npx tsc --noEmit -p electron/tsconfig.json` passes
- [ ] `npx tsc --noEmit` (renderer) passes
- [ ] `cd mcp && npx tsc --noEmit` passes
- [ ] `npm run lint` has no new errors
- [ ] Feature or fix is described in the PR body
- [ ] Added or updated tests if the change is non-trivial
- [ ] For UI changes, include a screenshot or short GIF

We do not require Contributor License Agreements. By contributing, you agree
your contribution is licensed under Apache 2.0 (see LICENSE).

## Reporting bugs

Open an issue with:
1. Conduit version (Settings → About, or the app menu)
2. Operating system and version
3. Steps to reproduce
4. What you expected vs. what happened
5. Any console errors (View → Toggle Developer Tools → Console)

## Reporting security issues

Please don't file public issues for security vulnerabilities. See [SECURITY.md](./SECURITY.md).

## Code style

- TypeScript strict mode
- Prefer small, focused files
- No emoji in committed code or comments
- Match surrounding style; we don't publish a formal style guide

## Community

- Issues: https://github.com/advenimus/conduit-desktop/issues
- Discussions: https://github.com/advenimus/conduit-desktop/discussions
