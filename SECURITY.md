# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Conduit, please report it privately
so we can fix it before it's exploited.

### Preferred channel

Email: **support@conduitdesktop.com**

Please include:
- A description of the issue
- Steps to reproduce (or a proof of concept)
- The version of Conduit you tested against
- Your suggested severity (low / medium / high / critical)

We aim to acknowledge reports within **48 hours** and provide a fix or timeline
within **7 days** for high-severity issues.

### What qualifies

Examples of issues we want to hear about:

- Vault decryption without the master password
- Credential leakage through logs, crash reports, or side channels
- Remote code execution via a malicious connection target
- MCP tool abuse that bypasses the approval flow
- IPC socket accessible to unintended local processes
- Supply-chain issues in our dependencies that affect users

### What doesn't qualify

- Issues in packages we depend on that have no Conduit-specific exploit path
  (report those upstream)
- Self-XSS requiring the user to paste attacker-controlled code into DevTools
- Weaknesses that require an attacker to already have full root on the user's
  machine (at that point, the vault is already theirs)
- Missing security headers on `conduitdesktop.com` (that's a separate site —
  report to the same address but it's out of scope for this repo)

### Responsible disclosure

We ask that you:

- Give us reasonable time to issue a fix before disclosing publicly
- Don't test on accounts or systems you don't own
- Don't exfiltrate user data during testing

Once a fix ships, we'll credit you in the release notes unless you prefer to
remain anonymous.

## Supported versions

Only the latest released version of Conduit receives security updates. We
recommend enabling auto-update to stay current.

## Security model — quick overview

- **Vault:** AES-256-GCM, master password derived via Argon2id. The master
  password never leaves the device.
- **Cloud sync (Pro/Team):** vault entries are re-encrypted with a wrapping
  key derived from the master password before upload. The backend sees only
  ciphertext.
- **MCP server:** IPC over Unix socket (or named pipe on Windows) with the
  socket file only readable by the current user. Tools that read credentials
  require explicit user approval; tools that execute commands are gated by
  per-tool approval policies.
- **AI agents:** Claude Code and Codex authenticate directly with Anthropic
  and OpenAI via your own subscription. Conduit never sees your API keys or
  proxies your inference calls.
