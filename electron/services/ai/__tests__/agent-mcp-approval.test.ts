import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  approveConduitServer,
  approveCursorConduitServer,
  ensureConduitServerApproved,
} from '../agent-mcp-approval.js';

describe('approveCursorConduitServer', () => {
  it("runs Cursor's own approve command inside the agent folder", async () => {
    const calls: unknown[][] = [];
    await approveCursorConduitServer('/agents/cursor', 'cursor-agent', async (...args) => {
      calls.push(args);
    });
    expect(calls).toEqual([
      ['cursor-agent', ['mcp', 'enable', 'conduit'], { cwd: '/agents/cursor', timeout: 15_000 }],
    ]);
  });

  it('passes a failed approval back to the caller', async () => {
    const run = async () => {
      throw new Error('cursor-agent not found');
    };
    await expect(approveCursorConduitServer('/agents/cursor', 'cursor-agent', run)).rejects.toThrow(
      'cursor-agent not found',
    );
  });
});

describe('approveConduitServer', () => {
  it('moves conduit from the disabled list to the enabled list', () => {
    const result = approveConduitServer({
      disabledMcpjsonServers: ['conduit', 'other'],
      enabledMcpjsonServers: ['extra'],
    });
    expect(result.disabledMcpjsonServers).toEqual(['other']);
    expect(result.enabledMcpjsonServers).toEqual(['extra', 'conduit']);
  });

  it('drops an emptied disabled list and keeps unrelated settings', () => {
    const permissions = { allow: ['mcp__conduit__connection_list'] };
    const result = approveConduitServer({ permissions, disabledMcpjsonServers: ['conduit'] });
    expect(result).toEqual({ permissions, enabledMcpjsonServers: ['conduit'] });
  });

  it('does not change the input object', () => {
    const input = { disabledMcpjsonServers: ['conduit'] };
    approveConduitServer(input);
    expect(input).toEqual({ disabledMcpjsonServers: ['conduit'] });
  });

  it('leaves already-approved settings as they are', () => {
    const input = { enabledMcpjsonServers: ['conduit'] };
    expect(approveConduitServer(input)).toEqual(input);
  });
});

describe('ensureConduitServerApproved', () => {
  let agentDir: string;
  const settingsPath = () => path.join(agentDir, '.claude', 'settings.local.json');

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-agent-'));
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it('creates the settings file when the folder has none', () => {
    ensureConduitServerApproved(agentDir);
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))).toEqual({
      enabledMcpjsonServers: ['conduit'],
    });
  });

  it('re-enables a conduit server the user declined', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ permissions: { allow: ['x'] }, disabledMcpjsonServers: ['conduit'] }),
    );
    ensureConduitServerApproved(agentDir);
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))).toEqual({
      permissions: { allow: ['x'] },
      enabledMcpjsonServers: ['conduit'],
    });
  });

  it('does not overwrite a settings file it cannot parse', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), '{ not json');
    expect(() => ensureConduitServerApproved(agentDir)).toThrow();
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe('{ not json');
  });
});
