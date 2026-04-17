# <img src="readme/conduit-icon.png" alt="Conduit" width="36"> Conduit

**The remote-connection manager Claude Code can drive.**

[![Download](https://img.shields.io/github/v/release/advenimus/conduit-desktop?label=Download&style=for-the-badge)](https://github.com/advenimus/conduit-desktop/releases/latest) [![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=for-the-badge)](#installation) [![MCP](https://img.shields.io/badge/MCP-Compatible-green?style=for-the-badge)](#mcp-quick-start) [![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=for-the-badge)](LICENSE)

<img src="readme/og-image.png" alt="Conduit Desktop App" width="800">

---

## What is Conduit?

Conduit is a cross-platform remote connection manager for **SSH, RDP, VNC, and web sessions** with an encrypted credential vault. It runs on macOS, Windows, and Linux.

What makes it different: Conduit ships a **Model Context Protocol (MCP) server** that exposes every connection, every session, and every credential operation as a tool. Point Claude Code or Codex at it and your AI agent can open an SSH shell, click through an RDP desktop, fill out a web form, read credentials with approval, or manage a fleet of servers — through the same connections you already use.

Conduit does not ship its own AI. You bring your own: **Claude Code** (Anthropic) or **Codex** (OpenAI), using your own subscription. Conduit never proxies your AI calls and never sees your API keys or tokens.

### Who is Conduit for?

- **DevOps & SREs** who want their AI agent to operate real infrastructure, not just generate text about it
- **System administrators** managing mixed SSH / RDP / VNC fleets
- **IT professionals** who need one tool for shells, remote desktops, and web portals
- **AI-first engineers** already using Claude Code or Codex daily
- **Teams** that need shared, zero-knowledge credential vaults

---

## Why Conduit

- **MCP-native.** The MCP server is not an add-on — it is the product's first-class interface. Anything you can do in the UI, an agent can do through a tool call.
- **BYOK, no proxy.** Claude Code and Codex authenticate directly with their providers using your own account. Conduit never sees your API keys, tokens, or prompts.
- **Local-first.** Credentials live in a local AES-256 vault. Cloud sync is optional and zero-knowledge.
- **Open source client.** The Electron app, protocol handlers, FreeRDP helper, and MCP server are Apache 2.0. You can read exactly what AI agents can see and do.
- **Multi-protocol.** SSH, RDP, VNC, web — one app, one vault, one MCP endpoint.

---

## MCP Quick Start

Register Conduit's MCP server with Claude Code:

```bash
# macOS
claude mcp add conduit -- node "/Applications/Conduit.app/Contents/Resources/mcp/dist/index.js" \
  --env CONDUIT_SOCKET_PATH="$HOME/Library/Application Support/conduit/conduit.sock" \
  --env CONDUIT_ENV="production"
```

```bash
# Windows (PowerShell)
claude mcp add conduit -- node "C:\Users\<you>\AppData\Local\Programs\Conduit\resources\mcp\dist\index.js" `
  --env CONDUIT_SOCKET_PATH="\\.\pipe\conduit" `
  --env CONDUIT_ENV="production"
```

```bash
# Linux
claude mcp add conduit -- node "/opt/Conduit/resources/mcp/dist/index.js" \
  --env CONDUIT_SOCKET_PATH="$XDG_RUNTIME_DIR/conduit/conduit.sock" \
  --env CONDUIT_ENV="production"
```

Then in any Claude Code session:

```
> list my active connections
> run `uptime` on the prod-db-1 SSH session
> take a screenshot of the Windows RDP box and click the Start menu
```

Codex and other MCP-compatible clients work the same way — Conduit exposes a standard MCP endpoint over a local Unix socket (or named pipe on Windows).

> **Free tier: 50 MCP tool calls per day. Pro and Team: unlimited.** Local mode (no sign-in) also runs under the Free quota.

---

## Key Features

### Remote connection management

Tabbed sessions, split-view panes, and side-by-side work across protocols.

<img src="readme/split-view-panes.gif" alt="Split-view panes" width="720">

| Protocol | Highlights |
|----------|------------|
| **SSH** | xterm.js terminal, key + password auth, multi-session tabs |
| **RDP** | FreeRDP 3.x engine, dynamic resize (RDPEDISP), clipboard sync, drag-and-drop file transfer, High DPI / Retina |
| **VNC** | Full mouse/keyboard interaction, clipboard sync, screenshot capture |
| **Web** | Native Chromium webview, multi-tab browsing, autofill, DOM-aware interaction |
| **Commands** | Run local scripts as managed entries with timeout and shell selection |

- Bidirectional clipboard for RDP and VNC
- Shared folder redirection with per-drive read-only enforcement
- Edge / WebView2 on Windows for native SSO against M365, ServiceNow, SharePoint
- Up to 12 tabs per web session with address bar and navigation controls

<img src="readme/rdp-file-transfer.gif" alt="RDP file transfer" width="720">

---

### MCP server — the differentiator

The MCP server exposes 60+ tools covering every corner of the app. Agents connect over a local socket; nothing leaves your machine unless you tell it to.

<img src="readme/mcp-agent-workflow.gif" alt="MCP agent workflow" width="720">

```
Terminal     execute commands, read output, send keystrokes, create local shells
RDP          screenshot, click, type, drag, scroll, resize remote desktops
VNC          screenshot, click, type, drag, scroll remote sessions
Web          screenshot, navigate, click by CSS selector, fill forms, execute JS
Web tabs     list, create, close, switch tabs in web sessions
Credentials  list, create, read (with approval), delete stored credentials
Connections  list, open, close SSH / RDP / VNC / web sessions
Documents    read, create, update markdown documents in the vault
Entries      get metadata, update notes on any vault entry
```

Supported agents:

| Agent | Integration |
|-------|-------------|
| **Claude Code** (Anthropic) | Full MCP tool access. BYOK — your Claude subscription. |
| **Codex CLI** (OpenAI) | Full MCP tool access. BYOK — your OpenAI subscription. |
| Any MCP-compatible client | Standard MCP over local socket / named pipe. |

> Conduit does not proxy AI requests and does not see your API keys, tokens, or conversation content. Claude Code and Codex connect directly to their respective providers using credentials you manage.

#### How it works

1. Connect to your servers via SSH, RDP, VNC, or web in Conduit.
2. Ask Claude Code or Codex to perform a task against those connections.
3. Approve tool calls through the universal approval gate (or mark trusted tools "always allow").
4. Watch the agent work — executing commands, driving GUIs, reading screens.

#### Safety controls

- Per-tool and per-category approval with color-coded badges (read, execute, write, credential)
- Sensitive argument masking (passwords and tokens redacted in prompts)
- 120-second auto-deny timeout for unattended prompts
- Rate limiting and full audit logging
- Daily quota enforcement (50 calls/day on Free)

<img src="readme/mcp-approval-dialog.gif" alt="MCP approval dialog" width="600">

---

### Agent chat panel

Conduit's in-app chat panel hosts **Claude Code and Codex sessions** side-by-side with your connections. The chat UI is a thin shell — the agent binaries run locally, authenticate with their own providers, and drive Conduit through the same MCP endpoint an external agent would use.

<img src="readme/ai-chat-panel.png" alt="Agent chat panel">

No built-in models. No proxied API calls. No subscription bundled with Conduit.

---

### Encrypted credential vault

All credentials live in a local, AES-256 encrypted vault — not in plaintext config files, not in the cloud (unless you opt in to Pro sync).

<img src="readme/credential-vault.png" alt="Credential vault" width="680">

- AES-256 with master-password key derivation
- SSH key storage with fingerprint display and key generation (Ed25519, RSA, ECDSA)
- TOTP / MFA codes with countdown timer
- Password generator with configurable length and character sets
- Auto-lock on inactivity
- Auto-type into active sessions (right-click a credential)
- Global credential picker — `Cmd+Shift+Space` from anywhere, even when tray-minimized
- Passphrase-encrypted `.conduit-export` files

---

### Team vaults (Pro/Team, optional)

Zero-knowledge credential sharing. The server stores ciphertext; keys never leave the client.

<img src="readme/team-vault.gif" alt="Team vaults" width="720">

- X25519 key exchange, per-vault encryption keys
- Realtime sync across devices
- Folder-level roles (admin / editor / viewer)
- VEK rotation when members are removed
- 2-year audit retention, offline change queue
- 6-word BIP39 recovery passphrase

---

### Platform themes

Four OS-native themes with matching icon sets.

<img src="readme/platform-themes-grid.gif" alt="Platform themes" width="720">

| Theme | Style |
|-------|-------|
| **Default** | Conduit Classic |
| **macOS Tahoe** | Liquid-glass translucency, SF Pro, backdrop blur |
| **Windows 11** | Fluent, Mica surfaces, Segoe UI, WinUI 3 controls |
| **Ubuntu** | GNOME / Libadwaita, Ubuntu font |

Dark + light modes, plus Ocean, Ember, Forest, Amethyst, Rose, Midnight, and OS-native color schemes.

---

### Import from other tools

- **Devolutions Remote Desktop Manager** (`.rdm`) — SSH, RDP, VNC, web, credentials, folders, secure notes, documents. Automatic decryption, duplicate detection, folder preservation.
- **Conduit vault export** (`.conduit-export`) — encrypted transfer between vaults.

<img src="readme/import-rdm-preview.png" alt="Import from RDM" width="680">

---

## Pricing

| Plan | Monthly | Annual | What you get |
|------|---------|--------|--------------|
| **Free** | $0 | $0 | Unlimited local connections, MCP with **50 tool calls/day**, Claude Code + Codex (BYOK), 1-day cloud backup. No credit card. |
| **Pro** | $10/mo | $8/mo ($96/yr) | Unlimited MCP, cloud sync across devices, 14-day backup |
| **Team** | $20/seat/mo | $16/seat/mo ($192/yr) | Shared team vaults, 6-month backup, beta features |

Local mode (no sign-in required) runs under the Free quota. Registration unlocks cloud sync and team features.

Full pricing at [conduitdesktop.com/pricing](https://conduitdesktop.com/pricing).

---

## Installation

Download the latest release from [GitHub Releases](https://github.com/advenimus/conduit-desktop/releases/latest) or [conduitdesktop.com/download](https://conduitdesktop.com/download).

- **macOS** — `.dmg`, Apple Silicon and Intel
- **Windows** — `.exe`, Windows 10/11 (x64 and ARM64)
- **Linux** — `.AppImage` or `.deb`, x64 and ARM64

---

## Comparison

| | Conduit | Devolutions RDM | Royal TS | Termius | MobaXterm |
|---|---|---|---|---|---|
| SSH / RDP / VNC / Web | Yes | Yes | Yes | SSH + limited | Yes (Windows) |
| **Built-in MCP server for AI agents** | **Yes** | No | No | No | No |
| Claude Code / Codex integration | Yes (BYOK) | No | No | No | No |
| macOS native app | Yes | Limited | No (Windows-first) | Yes | No |
| Zero-knowledge team vaults | Yes | Requires DVLS server | Requires server | Yes | N/A |
| Open-source client | **Yes (Apache 2.0)** | No | No | No | Partial |
| Free tier | Yes | Free for personal | Free (limited) | Free (limited) | Free (Home) |
| Pro pricing | $8–$10 /mo | $200/yr (Team) | $70 one-time | $10/mo | $69 one-time (Pro) |

Conduit's angle: it is the only remote-connection manager built to be driven by an AI agent. If you already use Claude Code or Codex, Conduit is the bridge between your agent and your infrastructure.

---

## What's open source, what's not

**This repository (Apache 2.0):**

- Electron client and React UI
- SSH, RDP, VNC, and web session handlers
- FreeRDP 3.x C helper and dylib bundling
- **MCP server** (`mcp/`) — tool implementations, IPC client, rate limiter, audit logger
- Credential vault (local encryption, key derivation, TOTP)
- Import/export pipelines

**Proprietary (separate private repos):**

- Backend API — billing, Stripe integration, tier enforcement, device fingerprinting, cloud sync
- Marketing website (`conduitdesktop.com`)

**Why open-core?** Agent-driven remote access is high-trust territory. We think users should be able to read exactly what an AI agent can see and do when it connects to Conduit. Open-sourcing the client and the MCP server makes that auditable. Keeping billing and sync infrastructure proprietary lets us sustain the project.

---

## Contributing

We welcome issues, discussions, and pull requests. A `CONTRIBUTING.md` with dev setup, code style, and PR conventions is in progress — watch this repo for it.

In the meantime:

- File bugs and feature requests at [GitHub Issues](https://github.com/advenimus/conduit-desktop/issues)
- Check open discussions before starting large changes
- Sign your commits and keep PRs focused

---

## Documentation

Full documentation at [conduitdesktop.com/docs](https://conduitdesktop.com/docs):

- [Getting Started](https://conduitdesktop.com/docs/getting-started)
- [SSH](https://conduitdesktop.com/docs/connections/ssh) · [RDP](https://conduitdesktop.com/docs/connections/rdp) · [VNC](https://conduitdesktop.com/docs/connections/vnc) · [Web](https://conduitdesktop.com/docs/connections/web)
- [MCP Server Setup](https://conduitdesktop.com/docs/mcp/setup)
- [MCP Tools Reference](https://conduitdesktop.com/docs/mcp/tools)
- [Claude Code Integration](https://conduitdesktop.com/docs/agents/claude-code)
- [Codex Integration](https://conduitdesktop.com/docs/agents/codex)
- [Vault & Credentials](https://conduitdesktop.com/docs/vault/security)
- [Team Vaults](https://conduitdesktop.com/docs/vault/team-vaults)
- [Import Guide](https://conduitdesktop.com/docs/import)

---

## Support

- **Bug reports** — [GitHub Issues](https://github.com/advenimus/conduit-desktop/issues) or in-app via Help > Submit a Bug
- **Feature requests** — [GitHub Issues](https://github.com/advenimus/conduit-desktop/issues) or in-app via Help > Submit Feedback
- **Website** — [conduitdesktop.com](https://conduitdesktop.com)

---

## License

This repository is licensed under [Apache License 2.0](LICENSE).

The Conduit backend API and marketing website are proprietary and live in separate repositories. Conduit, the Conduit logo, and associated branding are trademarks of the Conduit project maintainers.

---

## Keywords

`remote-desktop-manager` `ssh-client` `rdp-client` `vnc-client` `mcp-server` `model-context-protocol` `claude-code` `codex` `ai-agent-tools` `credential-vault` `password-manager` `connection-manager` `devops-tools` `sysadmin` `remote-access` `electron` `cross-platform` `team-vault` `zero-knowledge-encryption` `freerdp` `open-source` `apache-2`

---

<p align="center">
  <a href="https://conduitdesktop.com">conduitdesktop.com</a>
</p>
