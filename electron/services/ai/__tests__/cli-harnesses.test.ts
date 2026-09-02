import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  ENGINE_TYPES,
  getHarness,
  getLaunchSpec,
  isKnownEngineType,
  mcpSetupCommand,
  pickCursorBinary,
  projectMcpConfigFiles,
} from '../cli-harnesses.js';
import { resolveAgentWorkingDir } from '../agent-working-dir.js';

describe('cli harness catalog', () => {
  it('lists every shipped engine in a stable order', () => {
    expect(ENGINE_TYPES).toEqual([
      'claude-code',
      'codex',
      'grok',
      'cursor',
      'openclaw',
      'gemini',
      'copilot',
      'opencode',
    ]);
  });

  it('rejects unknown engine ids', () => {
    expect(isKnownEngineType('claude-code')).toBe(true);
    expect(isKnownEngineType('grok')).toBe(true);
    expect(isKnownEngineType('not-a-real-engine')).toBe(false);
    expect(isKnownEngineType('')).toBe(false);
  });

  it('maps each engine to the interactive CLI launch spec', () => {
    expect(getLaunchSpec('claude-code')).toEqual({ command: 'claude', args: [] });
    expect(getLaunchSpec('codex')).toEqual({ command: 'codex', args: [] });
    expect(getLaunchSpec('grok')).toEqual({ command: 'grok', args: [] });
    expect(getLaunchSpec('cursor')).toEqual({ command: 'cursor-agent', args: [] });
    expect(getLaunchSpec('openclaw')).toEqual({ command: 'openclaw', args: ['tui', '--local'] });
    expect(getLaunchSpec('gemini')).toEqual({ command: 'gemini', args: [] });
    expect(getLaunchSpec('copilot')).toEqual({ command: 'copilot', args: [] });
    expect(getLaunchSpec('opencode')).toEqual({ command: 'opencode', args: [] });
  });

  it('lets Cursor spawn a verified agent binary when cursor-agent is missing', () => {
    expect(getLaunchSpec('cursor', 'agent')).toEqual({ command: 'agent', args: [] });
  });
});

describe('pickCursorBinary', () => {
  it('prefers cursor-agent when it exists', () => {
    expect(
      pickCursorBinary([
        { name: 'cursor-agent', exists: true },
        { name: 'agent', exists: true, version: 'Grok Build 1.0' },
      ]),
    ).toBe('cursor-agent');
  });

  it('falls back to agent only when the version banner looks like Cursor', () => {
    expect(
      pickCursorBinary([
        { name: 'cursor-agent', exists: false },
        { name: 'agent', exists: true, version: 'cursor-agent 2026.08.25' },
      ]),
    ).toBe('agent');
  });

  it('does not use a non-Cursor agent binary', () => {
    expect(
      pickCursorBinary([
        { name: 'cursor-agent', exists: false },
        { name: 'agent', exists: true, version: 'Grok Build 4.6' },
      ]),
    ).toBe('cursor-agent');
  });
});

describe('mcp setup commands', () => {
  const p = '/tmp/conduit/mcp/dist/index.js';
  const s = '/tmp/conduit.sock';

  it('keeps the existing Claude Code and Codex commands', () => {
    expect(mcpSetupCommand('claude-code', p, s)).toBe(
      `claude mcp add --transport stdio --scope project conduit -e CONDUIT_SOCKET_PATH="${s}" -- node "${p}"`,
    );
    expect(mcpSetupCommand('codex', p, s)).toBe(
      `codex mcp add conduit -e CONDUIT_SOCKET_PATH="${s}" -- node "${p}"`,
    );
  });

  it('emits grok, gemini, copilot, and openclaw add commands', () => {
    expect(mcpSetupCommand('grok', p, s)).toBe(
      `grok mcp add --scope project conduit -e CONDUIT_SOCKET_PATH="${s}" -- node "${p}"`,
    );
    expect(mcpSetupCommand('gemini', p, s)).toBe(
      `gemini mcp add -s project -e CONDUIT_SOCKET_PATH="${s}" conduit node "${p}"`,
    );
    expect(mcpSetupCommand('copilot', p, s)).toBe(
      `copilot mcp add conduit -e CONDUIT_SOCKET_PATH="${s}" -- node "${p}"`,
    );
    expect(mcpSetupCommand('openclaw', p, s)).toBe(
      `openclaw mcp add conduit --command node --arg "${p}" --env CONDUIT_SOCKET_PATH="${s}"`,
    );
  });

  it('emits Cursor and OpenCode project config snippets', () => {
    const cursor = mcpSetupCommand('cursor', p, s);
    expect(cursor).toContain('.cursor/mcp.json');
    expect(cursor).toContain(p);
    expect(cursor).toContain(s);

    const opencode = mcpSetupCommand('opencode', p, s);
    expect(opencode).toContain('opencode.json');
    expect(opencode).toContain(p);
    expect(opencode).toContain(s);
  });

  it('exposes a label for every harness', () => {
    for (const id of ENGINE_TYPES) {
      expect(getHarness(id).name.length).toBeGreaterThan(0);
      expect(mcpSetupCommand(id, p, s).length).toBeGreaterThan(0);
    }
  });
});

describe('resolveAgentWorkingDir', () => {
  const dataDir = '/tmp/conduit-dev';
  const existing = new Set<string>(['/projects/app', '/custom/workdir']);

  it('uses an explicit cwd when it exists', () => {
    const result = resolveAgentWorkingDir({
      engineType: 'grok',
      explicitCwd: '/projects/app',
      defaultWorkingDirectory: '/custom/workdir',
      dataDir,
      exists: (p) => existing.has(p),
      mkdir: () => undefined,
    });
    expect(result).toEqual({ cwd: '/projects/app', usedManagedAgentDir: false });
  });

  it('falls back to the settings default working directory', () => {
    const result = resolveAgentWorkingDir({
      engineType: 'grok',
      explicitCwd: '/missing',
      defaultWorkingDirectory: '/custom/workdir',
      dataDir,
      exists: (p) => existing.has(p),
      mkdir: () => undefined,
    });
    expect(result).toEqual({ cwd: '/custom/workdir', usedManagedAgentDir: false });
  });

  it('creates the per-engine agent directory as the last resort', () => {
    const created: string[] = [];
    const result = resolveAgentWorkingDir({
      engineType: 'openclaw',
      explicitCwd: null,
      defaultWorkingDirectory: null,
      dataDir,
      exists: () => false,
      mkdir: (p) => {
        created.push(p);
      },
    });
    expect(result.usedManagedAgentDir).toBe(true);
    expect(result.cwd).toBe(path.join(dataDir, 'agent', 'openclaw'));
    expect(created).toEqual([result.cwd]);
  });
});

describe('projectMcpConfigFiles', () => {
  it('always writes .mcp.json', () => {
    const files = projectMcpConfigFiles('cursor', '/mcp/index.js', '/tmp/sock', 'preview');
    const mcpJson = files.find((f) => f.relativePath === '.mcp.json');
    expect(mcpJson).toBeDefined();
    const parsed = JSON.parse(mcpJson!.contents) as {
      mcpServers: { conduit: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(parsed.mcpServers.conduit.command).toBe('node');
    expect(parsed.mcpServers.conduit.args).toEqual(['/mcp/index.js']);
    expect(parsed.mcpServers.conduit.env.CONDUIT_SOCKET_PATH).toBe('/tmp/sock');
  });

  it('also writes .cursor/mcp.json for Cursor', () => {
    const cursorFiles = projectMcpConfigFiles('cursor', '/mcp/index.js', '/tmp/sock', 'preview');
    expect(cursorFiles.some((f) => f.relativePath === '.cursor/mcp.json')).toBe(true);

    const grokFiles = projectMcpConfigFiles('grok', '/mcp/index.js', '/tmp/sock', 'preview');
    expect(grokFiles.some((f) => f.relativePath === '.cursor/mcp.json')).toBe(false);
  });
});
