/**
 * One-shot migration for stale Conduit MCP entries in the user's Claude Code
 * config (`~/.claude.json`).
 *
 * Background: prior to the open-source pivot, the desktop app and its MCP
 * lived at `~/Github/conduit/`. Users who registered the MCP via
 * `claude mcp add conduit -- node "/Users/.../conduit/mcp/dist/index.js"`
 * still have that stale path in `~/.claude.json`. The stale binary connects
 * to the new IPC socket but emits legacy `GetQuotaMirror`/`SetQuotaMirror`
 * requests the new IPC server doesn't recognise, spamming the dev console
 * and bypassing the new desktop-side daily-quota counter.
 *
 * This module rewrites such entries to the current build's MCP path on app
 * startup. Idempotent — safe to run every launch. Only touches entries that
 * are *clearly* the predecessor binary (entry name `conduit` AND args path
 * matches `/conduit/mcp/dist/index.js` or any other non-current Conduit MCP
 * dist). Leaves user-authored entries alone.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getSocketPath } from '../ipc-server/server.js';
import { getDataDir, getEnvConfig } from './env-config.js';

interface StdioMcpServer {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ClaudeConfig {
  mcpServers?: Record<string, StdioMcpServer>;
  projects?: Record<string, { mcpServers?: Record<string, StdioMcpServer> }>;
  [key: string]: unknown;
}

// Anchored pattern for config-args matching (args[0] is the binary path alone).
const CONDUIT_PATH_PATTERN = /[/\\](conduit(?:-desktop)?)[/\\]mcp[/\\]dist[/\\]index\.(?:js|cjs|mjs)$/i;
// Lenient version for process-command-line matching (followed by args or EOL).
const CONDUIT_PATH_IN_COMMAND = /[/\\](conduit(?:-desktop)?)[/\\]mcp[/\\]dist[/\\]index\.(?:js|cjs|mjs)(?:\s|$)/i;

function getClaudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

function isStaleConduitEntry(entry: StdioMcpServer | undefined, currentMcpPath: string): boolean {
  if (!entry || entry.command !== 'node') return false;
  const argsPath = entry.args?.[0];
  if (!argsPath || typeof argsPath !== 'string') return false;
  if (!CONDUIT_PATH_PATTERN.test(argsPath)) return false;
  // Already points at the current build → leave it.
  return path.normalize(argsPath) !== path.normalize(currentMcpPath);
}

function buildCanonicalEntry(currentMcpPath: string): StdioMcpServer {
  return {
    type: 'stdio',
    command: 'node',
    args: [currentMcpPath],
    env: {
      CONDUIT_SOCKET_PATH: getSocketPath(),
      CONDUIT_ENV: getEnvConfig().environment,
    },
  };
}

/**
 * Migrate any stale Conduit MCP entries in `~/.claude.json` to the current
 * build's path. Returns the number of entries rewritten (0 if nothing to do
 * or the file doesn't exist). Errors are logged and swallowed — the app
 * must keep starting even if Claude Code config is unreadable.
 */
export function migrateStaleConduitMcpEntries(currentMcpPath: string): number {
  const configPath = getClaudeConfigPath();
  if (!fs.existsSync(configPath)) return 0;

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    console.warn('[mcp-migration] Could not read ~/.claude.json:', err);
    return 0;
  }

  let config: ClaudeConfig;
  try {
    config = JSON.parse(raw) as ClaudeConfig;
  } catch (err) {
    console.warn('[mcp-migration] ~/.claude.json is not valid JSON, skipping:', err);
    return 0;
  }

  let migrated = 0;
  const canonical = buildCanonicalEntry(currentMcpPath);

  // User-scope entry
  if (config.mcpServers && isStaleConduitEntry(config.mcpServers.conduit, currentMcpPath)) {
    config.mcpServers.conduit = canonical;
    migrated += 1;
  }

  // Project-scope entries
  if (config.projects && typeof config.projects === 'object') {
    for (const project of Object.values(config.projects)) {
      if (project?.mcpServers && isStaleConduitEntry(project.mcpServers.conduit, currentMcpPath)) {
        project.mcpServers.conduit = canonical;
        migrated += 1;
      }
    }
  }

  if (migrated === 0) return 0;

  // Backup once per migration so the original is recoverable if anything
  // looks wrong. Timestamped to avoid clobbering prior backups.
  try {
    const backupPath = `${configPath}.conduit-backup-${Date.now()}`;
    fs.writeFileSync(backupPath, raw, 'utf-8');
  } catch (err) {
    console.warn('[mcp-migration] Failed to write backup, aborting migration:', err);
    return 0;
  }

  // Atomic write — same pattern the MCP uses for mcp-quota.json.
  const tmpPath = `${configPath}.conduit-migration.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmpPath, configPath);
    console.log(`[mcp-migration] Rewrote ${migrated} stale Conduit MCP entr${migrated === 1 ? 'y' : 'ies'} → ${currentMcpPath}`);
  } catch (err) {
    console.warn('[mcp-migration] Failed to persist migrated config:', err);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return 0;
  }

  return migrated;
}

/**
 * Refresh the project-scoped `.mcp.json` in each in-app agent directory so
 * it points at the current build's MCP path, not a stale predecessor path.
 *
 * Why a startup refresh AND a session-creation refresh? The session-creation
 * hook in engine.ts only fires when the user explicitly creates a new
 * session. Existing/cached sessions reuse the same working directory and
 * its (potentially stale) `.mcp.json`. Doing it here on app startup
 * guarantees the file is fresh before *any* CLI host can read it, which
 * is what `reapStaleConduitMcpProcesses` needs to be effective.
 *
 * Only ever touches `{getDataDir()}/agent/{engineType}/.mcp.json` — never
 * user-chosen working directories. We only know about engines we ship.
 */
export function refreshAgentMcpConfigs(currentMcpPath: string): void {
  const engineTypes = ['claude-code', 'codex'] as const;
  const env = getEnvConfig().environment;
  const socket = getSocketPath();
  const config = {
    mcpServers: {
      conduit: {
        type: 'stdio',
        command: 'node',
        args: [currentMcpPath],
        env: {
          CONDUIT_SOCKET_PATH: socket,
          CONDUIT_ENV: env,
          CONDUIT_INTERNAL_AGENT: '1',
        },
      },
    },
  };
  const serialized = JSON.stringify(config, null, 2);
  for (const engineType of engineTypes) {
    const agentDir = path.join(getDataDir(), 'agent', engineType);
    if (!fs.existsSync(agentDir)) continue; // No session ever opened — leave alone.
    const filePath = path.join(agentDir, '.mcp.json');
    try {
      // Only write if content differs — preserves mtime when nothing changed.
      let existing = '';
      try { existing = fs.readFileSync(filePath, 'utf-8'); } catch { /* missing */ }
      if (existing.trim() !== serialized.trim()) {
        fs.writeFileSync(filePath, serialized, 'utf-8');
        console.log(`[mcp-migration] Refreshed ${engineType} agent .mcp.json → ${currentMcpPath}`);
      }
    } catch (err) {
      console.warn(`[mcp-migration] Could not refresh ${engineType} agent .mcp.json:`, err);
    }
  }
}

/**
 * Reap any MCP node processes spawned from stale Conduit paths. When a
 * Claude Code (or Codex) session was already running at the moment we
 * rewrote `~/.claude.json`, it kept the stale process alive even though
 * the config now points at the current build. SIGTERMing those processes
 * lets the CLI host respawn them from the migrated config the next time
 * MCP is needed — restoring quota tracking and silencing the
 * `[UNKNOWN_REQUEST] GetQuotaMirror` spam without any user action.
 *
 * Conservative match: only nodeprocesses whose command line contains
 * `/conduit/mcp/dist/index.` or other historical Conduit-MCP locations
 * AND is not the current build's path. Returns the number of processes
 * killed. Best-effort; logged and swallowed on error.
 *
 * Windows: skipped — `ps` isn't reliably available, and Conduit on
 * Windows users are unlikely to have predecessor binaries installed.
 */
export function reapStaleConduitMcpProcesses(currentMcpPath: string): number {
  if (process.platform === 'win32') return 0;

  let psOut: string;
  try {
    psOut = execSync('ps -axww -o pid=,command=', { encoding: 'utf-8' });
  } catch (err) {
    console.warn('[mcp-migration] ps failed, cannot reap stale MCPs:', err);
    return 0;
  }

  const currentNorm = path.normalize(currentMcpPath);
  let killed = 0;
  for (const line of psOut.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) continue;
    const pidStr = trimmed.slice(0, spaceIdx);
    const command = trimmed.slice(spaceIdx + 1);
    const pid = parseInt(pidStr, 10);
    if (!Number.isFinite(pid) || pid === process.pid) continue;

    if (!/\bnode\b/.test(command)) continue;
    if (!CONDUIT_PATH_IN_COMMAND.test(command)) continue;
    if (command.includes(currentNorm)) continue;

    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[mcp-migration] Reaped stale Conduit MCP process pid=${pid}`);
      killed += 1;
    } catch (err) {
      // Process may have exited between ps and kill, or we lack permission.
      console.warn(`[mcp-migration] Could not SIGTERM pid=${pid}:`, err);
    }
  }
  return killed;
}
