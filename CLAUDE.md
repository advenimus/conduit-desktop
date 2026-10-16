# Conduit — AI-Powered Remote Connection Manager

This file is Claude Code's contributor guide for the Conduit desktop app. It explains the codebase layout, build workflow, and conventions so AI assistants can help you work effectively.

## Project Overview

Conduit is a cross-platform (macOS + Windows + Linux) remote connection manager with integrated MCP (Model Context Protocol) server support. AI agents like Claude Code can drive SSH, RDP, VNC, and web sessions through a standard MCP interface.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Electron 44 |
| Backend | Node.js + TypeScript (main process) |
| Frontend | React 18 + TypeScript + Vite |
| RDP | FreeRDP 3.x (C helper binary) |
| VNC | rfb2 |
| SSH | ssh2 |
| MCP | @modelcontextprotocol/sdk (TypeScript) |
| Backend | Appwrite (self-hosted; one `api` function, TypeScript) |
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
│   │   ├── auth/              # Appwrite auth service (auth-service.ts)
│   │   └── backend/           # ConduitDb client, function transport, Realtime
│   └── ipc-server/            # Unix socket server for the MCP binary
├── mcp/                       # MCP server (separate Node.js process)
│   ├── src/
│   │   ├── index.ts           # MCP server entry point
│   │   ├── tools/             # Tool implementations
│   │   ├── rate-limiter.ts    # Token bucket rate limiting
│   │   ├── audit.ts           # Audit logging
│   │   └── ipc-client.ts      # IPC client to the main app
│   └── package.json
├── src/                       # React frontend
│   ├── components/            # layout, connections, sessions, vault, auth, ai, settings
│   ├── stores/                # Zustand state stores
│   ├── hooks/                 # React hooks
│   └── lib/
├── appwrite/                  # Backend: `api` function, schema as code, deploy + local setup scripts
├── freerdp-helper/            # FreeRDP C helper (source + build scripts)
├── build/                     # Icons + entitlements for electron-builder
└── docs/                      # Contributor documentation
```

## Key Commands

```bash
# Install dependencies
npm install
cd mcp && npm install && cd ..

# Development (uses the local Appwrite stack + conduit-dev/ data dir)
npm run dev:electron

# Development with production data (uses production Appwrite + conduit/ data dir)
npm run dev:electron:prod

# Build
npm run build   # tsc + vite build + electron tsc + mcp tsc

# Build FreeRDP helper (C binary) — see docs/BUILD_FREERDP.md
cd freerdp-helper && bash build-freerdp.sh
bash scripts/build-macos.sh   # or build-linux.sh / build-windows.ps1
bash scripts/bundle-macos.sh  # macOS only — bundles dylibs for redistribution

# Local Appwrite stack (see docs/LOCAL_APPWRITE.md)
npm run appwrite:setup    # first time only
npm run appwrite:start    # start; redeploys appwrite/ if it changed
npm run appwrite:stop

# Run tests
npx vitest run
cd mcp && npx vitest run
npm run test:server       # backend unit tests (cd appwrite && npm test)

# TypeScript check
npx tsc --noEmit

# Lint
npm run lint
```

## Environment-Aware Data Paths

Dev and production use separate local data directories to avoid conflicts. Controlled by `CONDUIT_ENV` (set automatically by npm scripts).

| Environment | `CONDUIT_ENV` | Data Directory | Socket Path |
|---|---|---|---|
| Dev (default) | `preview` | `{appData}/conduit/conduit-dev/` | `.../conduit-dev/conduit.sock` |
| Prod / Packaged | `production` | `{appData}/conduit/conduit/` | `.../conduit/conduit.sock` |

Paths are centralized in `electron/services/env-config.ts` (`getDataDir()`, `getSocketPath()`). `electron/app-identity.ts` (the first import in `main.ts`) pins the data root and renames the dev build to "Conduit Dev", which gives it its own Chromium profile and single-instance lock. The MCP process (`mcp/src/ipc-client.ts`) derives the socket path from `CONDUIT_ENV` or an explicit `CONDUIT_SOCKET_PATH` override.

Both dev and prod instances can run simultaneously without socket or data conflicts. Whichever one has focus claims `conduit://` links.

## Architecture Notes

### AI Agent Integration
AI inference is **bring-your-own-subscription** via CLI agents (Claude Code, Codex). The desktop app does **not** proxy AI calls. Users install the CLI agent of their choice and the chat panel shells out to it under their own Anthropic or OpenAI plan.

Relevant code:
- `electron/services/ai/engines/` — Claude Code + Codex engine adapters
- `src/components/ai/ChatPanel.tsx` — chat UI
- `src/components/ai/EngineSelector.tsx` — engine picker

### MCP Server
The MCP server (`mcp/`) runs as a separate Node.js process. It communicates with the desktop app over a Unix domain socket (or named pipe on Windows). Every tool call is authorized and audited by the main process before execution.

Relevant code:
- `mcp/src/index.ts` — server entry
- `mcp/src/tools/` — tool implementations
- MCP tool calls are unlimited on every plan. The retired `mcp_daily_quota` tier key stays `-1` so older MCP builds stay uncapped.

### Appwrite
The backend is a self-hosted Appwrite. Production is `https://appwrite.cloudwise.ca/v1` (project `6acf9d610020fad67ba9`). Preview runs on a local Appwrite stack in Docker at `http://localhost:8085/v1` (project `conduit-dev`, see `docs/LOCAL_APPWRITE.md`). Run `npm run appwrite:start` before `npm run dev:electron`.

One Appwrite Function, `api` (`appwrite/src/api/`), takes PostgREST-style requests (table queries, RPCs, storage) and enforces the old Supabase rules, now in TypeScript. The schema is code in `appwrite/src/schema/tables.ts`; deploy with `node appwrite/scripts/deploy.ts` (local: `npm run appwrite:deploy`). The client contract is `docs/appwrite-migration/API_CONTRACT.md`. The SQL in `supabase/migrations/` is history only.

Desktop side: `electron/services/auth/auth-service.ts` adopts the session the website hands over (`conduit://auth/callback#user_id=...&session=...`) and stores it with safeStorage. Data access goes through `authService.getDb()` (a `ConduitDb` with the supabase-js call shape). Endpoints and project IDs live in `electron/services/env-config.ts`; they are public and safe to commit. The API key and service secret are never shipped in the app.

## Documentation

- `docs/FEATURES.md` — Feature list
- `docs/MULTI_DEVICE_SYNC.md`: personal vault multi-device sync and device limits (merge engine in `electron/services/sync/`, device leases in `electron/services/vault-session/`)
- `scripts/verify/README.md`: live end-to-end harness (`npm run verify`); agents run it with the `/verify`, `/verify-sync`, `/verify-mcp` and `/verify-ownership` skills in `.claude/skills/`
- `docs/KNOWLEDGE_BASE.md`: knowledge base and secret chips data contract shared with iOS (test vectors in `electron/services/knowledge/__vectors__/`)
- `docs/APPWRITE.md`: Appwrite backend architecture, tables, deploy and secrets
- `docs/LOCAL_APPWRITE.md`: local Appwrite stack for development
- `docs/appwrite-migration/API_CONTRACT.md`: request and response format of the `api` function
- `docs/ADDING_ENTRY_TYPES.md` — How to add new entry / credential types
- `docs/BUILD_FREERDP.md` — FreeRDP helper build instructions
- `docs/DEPENDENCY_UPGRADES.md` — Upgrade notes for major dependencies

## Conventions

- `npm run build` must pass before shipping
- `npx tsc --noEmit` must pass (no new type errors)
- Feature changes include a matching entry in `docs/FEATURES.md`
- Every release tag needs a notes file at `docs/releases/vX.Y.Z.md` merged first (format in `docs/releases/README.md`); the release workflow publishes it as the GitHub release body
- Live `/verify` suites: run only the suite that covers your change (`/verify-sync`, `/verify-mcp`, `/verify-ownership`, `/verify-data`). The full `npm run verify` runs only when the user asks for it or for a release candidate
- UI changes use the toast notification system documented in `.claude/commands/notification.md` — never `window.alert()` or custom modals for status messages

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution process, and [SECURITY.md](./SECURITY.md) for how to report vulnerabilities.
