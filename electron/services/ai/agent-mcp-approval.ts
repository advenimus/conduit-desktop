/**
 * Keeps each CLI's approval of the project `conduit` server turned on inside
 * Conduit-managed agent folders.
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

export type RunCommand = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<unknown>;

const CURSOR_APPROVE_TIMEOUT_MS = 15_000;

// Cursor keys its approval to a hash of the server config, so it must be renewed
// whenever the MCP path changes; its own CLI is the only stable way to do that.
export async function approveCursorConduitServer(
  agentDir: string,
  cursorBinary: string,
  run: RunCommand,
): Promise<void> {
  await run(cursorBinary, ['mcp', 'enable', SERVER_NAME], {
    cwd: agentDir,
    timeout: CURSOR_APPROVE_TIMEOUT_MS,
  });
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
