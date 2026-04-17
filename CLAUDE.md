# Conduit — AI-Powered Remote Connection Manager

This file is Claude Code's contributor guide for the Conduit desktop app. It explains the codebase layout, build workflow, and conventions so AI assistants can help you work effectively.

## Project Overview

Conduit is a cross-platform (macOS + Windows + Linux) remote connection manager with integrated MCP (Model Context Protocol) server support. AI agents like Claude Code can drive SSH, RDP, VNC, and web sessions through a standard MCP interface.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Electron 34 |
| Backend | Node.js + TypeScript (main process) |
| Frontend | React 18 + TypeScript + Vite |
| RDP | FreeRDP 3.x (C helper binary) |
| VNC | rfb2 |
| SSH | ssh2 |
| MCP | @modelcontextprotocol/sdk (TypeScript) |
| Terminal | xterm.js + node-pty |
| Styling | Tailwind CSS |
| State | Zustand |

## Project Structure

```
conduit-desktop/
├── electron/                  # Electron main process (Node.js/TypeScript)
│   ├── main.ts                # Entry point, BrowserWindow, WebContentsView
│   ├── preload.ts             # contextBridge IPC exposure
│   ├── ipc/                   # IPC handlers (connection, terminal, rdp, vnc, web, vault, ai, auth, settings)
│   ├── services/              # Backend service implementations
│   │   ├── vault/             # Credential encryption + storage
│   │   ├── ssh/               # SSH protocol (ssh2)
│   │   ├── terminal/          # Terminal management (node-pty)
│   │   ├── rdp/               # RDP protocol (FreeRDP 3.x C helper)
│   │   ├── vnc/               # VNC protocol (rfb2)
│   │   ├── web/               # Web session management
│   │   ├── ai/                # Claude Code + Codex engine adapters; MCP tool registry
│   │   └── auth/              # Supabase auth service
│   └── ipc-server/            # Unix socket server for the MCP binary
├── mcp/                       # MCP server (separate Node.js process)
│   ├── src/
│   │   ├── index.ts           # MCP server entry point
│   │   ├── tools/             # Tool implementations
│   │   ├── rate-limiter.ts    # Token bucket rate limiting
│   │   ├── daily-quota.ts     # Local daily MCP quota enforcement
│   │   ├── audit.ts           # Audit logging
│   │   └── ipc-client.ts      # IPC client to the main app
│   └── package.json
├── src/                       # React frontend
│   ├── components/            # layout, connections, sessions, vault, auth, ai, settings
│   ├── stores/                # Zustand state stores
│   ├── hooks/                 # React hooks
│   └── lib/
├── freerdp-helper/            # FreeRDP C helper (source + build scripts)
├── build/                     # Icons + entitlements for electron-builder
└── docs/                      # Contributor documentation
```

## Key Commands

```bash
# Install dependencies
npm install
cd mcp && npm install && cd ..

# Development (uses preview Supabase + conduit-dev/ data dir)
npm run dev:electron

# Development with production data (uses production Supabase + conduit/ data dir)
npm run dev:electron:prod

# Build
npm run build:electron

# Build FreeRDP helper (C binary) — see docs/BUILD_FREERDP.md
cd freerdp-helper && bash build-freerdp.sh
bash scripts/build-macos.sh   # or build-linux.sh / build-windows.ps1
bash scripts/bundle-macos.sh  # macOS only — bundles dylibs for redistribution

# Run tests
npx vitest run
cd mcp && npx vitest run

# TypeScript check
npx tsc --noEmit

# Lint
npm run lint
```

## Environment-Aware Data Paths

Dev and production use separate local data directories to avoid conflicts. Controlled by `CONDUIT_ENV` (set automatically by npm scripts).

| Environment | `CONDUIT_ENV` | Data Directory | Socket Path |
|---|---|---|---|
| Dev (default) | `preview` | `{userData}/conduit-dev/` | `.../conduit-dev/conduit.sock` |
| Prod / Packaged | `production` | `{userData}/conduit/` | `.../conduit/conduit.sock` |

Paths are centralized in `electron/services/env-config.ts` (`getDataDir()`, `getSocketPath()`). The MCP process (`mcp/src/ipc-client.ts`) derives the socket path from `CONDUIT_ENV` or an explicit `CONDUIT_SOCKET_PATH` override.

Both dev and prod instances can run simultaneously without socket or data conflicts.

## Architecture Notes

### AI Agent Integration
AI inference is **bring-your-own-key (BYOK)** via CLI agents (Claude Code, Codex). The desktop app does **not** proxy AI calls. Users install the CLI agent of their choice and the chat panel shells out to it.

Relevant code:
- `electron/services/ai/engines/` — Claude Code + Codex engine adapters
- `src/components/ai/ChatPanel.tsx` — chat UI
- `src/components/ai/EngineSelector.tsx` — engine picker

### MCP Server
The MCP server (`mcp/`) runs as a separate Node.js process. It communicates with the desktop app over a Unix domain socket (or named pipe on Windows). Every tool call is authorized and audited by the main process before execution.

Relevant code:
- `mcp/src/index.ts` — server entry
- `mcp/src/tools/` — tool implementations
- `mcp/src/daily-quota.ts` — local quota enforcement (Free tier: 50 tool calls / day; Pro/Team: unlimited)

### Supabase
Production runs on cloud Supabase. Preview runs on a local Supabase stack via Docker (see `docs/LOCAL_SUPABASE.md`). Start the local stack with `supabase start` before `npm run dev:electron`.

The local anon key is a well-known public development key baked into `env-config.ts` — safe to commit.

## Documentation

- `docs/FEATURES.md` — Feature list
- `docs/SUPABASE.md` — Supabase integration architecture
- `docs/LOCAL_SUPABASE.md` — Local Supabase setup for development
- `docs/ADDING_ENTRY_TYPES.md` — How to add new entry / credential types
- `docs/BUILD_FREERDP.md` — FreeRDP helper build instructions
- `docs/DEPENDENCY_UPGRADES.md` — Upgrade notes for major dependencies

## Conventions

- `npm run build:electron` must pass before shipping
- `npx tsc --noEmit` must pass (no new type errors)
- Feature changes include a matching entry in `docs/FEATURES.md`
- UI changes use the toast notification system documented in `.claude/commands/notification.md` — never `window.alert()` or custom modals for status messages

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution process, and [SECURITY.md](./SECURITY.md) for how to report vulnerabilities.
