/**
 * Keeps Claude Code's approval of the `conduit` server in `.mcp.json` turned on
 * inside Conduit-managed agent folders.
 *
 * Claude Code records "don't use this project server" in
 * `.claude/settings.local.json`. Once `conduit` lands in that list, the session
 * silently falls back to a user-scope `conduit` entry, which usually points at a
 * different Conduit build (production from the dev app, or the reverse).
 */

import fs from 'node:fs';
import path from 'node:path';

const SERVER_NAME = 'conduit';

interface ClaudeLocalSettings {
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  [key: string]: unknown;
}

export function approveConduitServer(settings: ClaudeLocalSettings): ClaudeLocalSettings {
  const { disabledMcpjsonServers, enabledMcpjsonServers, ...rest } = settings;
  const disabled = (disabledMcpjsonServers ?? []).filter((name) => name !== SERVER_NAME);
  const enabled = enabledMcpjsonServers ?? [];

  return {
    ...rest,
    ...(disabled.length > 0 ? { disabledMcpjsonServers: disabled } : {}),
    enabledMcpjsonServers: enabled.includes(SERVER_NAME) ? enabled : [...enabled, SERVER_NAME],
  };
}

/** Throws when the existing settings file can't be read or parsed; it is left untouched. */
export function ensureConduitServerApproved(agentDir: string): void {
  const settingsPath = path.join(agentDir, '.claude', 'settings.local.json');
  const existing = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf-8') : '';
  const current = existing.trim() === '' ? {} : (JSON.parse(existing) as ClaudeLocalSettings);
  const next = JSON.stringify(approveConduitServer(current), null, 2) + '\n';

  if (existing.trim() === next.trim()) return;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, next, 'utf-8');
}
