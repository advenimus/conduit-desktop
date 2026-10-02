// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actingSessionId, parseAgentIdentity, sessionInUseMessage } from '../agent-requests.js';
import {
  openSessionsForEntry,
  ownerOf,
  pruneClosedSessions,
  resetSessionClaimsForTest,
  runWithAgentClaims,
  sessionClaims,
  type SessionLookup,
} from '../agent-sessions.js';
import type { AgentIdentity } from '../session-claims.js';

const A: AgentIdentity = { id: 'agent-a', pid: 101, client: 'claude-code' };
const B: AgentIdentity = { id: 'agent-b', pid: 202, client: 'codex-mcp-client' };
const OK = { type: 'Success' as const, payload: { success: true } };

interface Fake extends SessionLookup {
  terminals: string[];
  agentTerminals: Set<string>;
  rdp: Set<string>;
  connections: Map<string, { session_id: string; connection_type: string; host: string | null; port: number | null; created_at: number }>;
}

function fakeState(): Fake {
  const terminals = ['ssh-1', 'shell-1'];
  const agentTerminals = new Set(['agent-pty']);
  const rdp = new Set<string>();
  const connections = new Map([
    ['ssh-1', { session_id: 'ssh-1', connection_type: 'ssh', host: '10.0.0.5', port: 22, created_at: 1 }],
    ['shell-1', { session_id: 'shell-1', connection_type: 'local_shell', host: null, port: null, created_at: 1 }],
  ]);
  return {
    terminals,
    agentTerminals,
    rdp,
    connections,
    mcpConnections: connections,
    terminalManager: {
      listSessions: () => [...terminals, ...agentTerminals],
      isAgentTerminal: (id) => agentTerminals.has(id),
    },
    rdpManager: { get: (id) => (rdp.has(id) ? {} : undefined) },
    vncManager: { get: () => undefined },
    webManager: { listSessions: () => [] },
  };
}

const execute = (sessionId: string) => ({ type: 'TerminalExecute', payload: { session_id: sessionId, command: 'ls' } });

let state: Fake;
let dead: Set<number>;

beforeEach(() => {
  resetSessionClaimsForTest();
  state = fakeState();
  dead = new Set();
  sessionClaims(state, { isProcessAlive: (pid) => !dead.has(pid) });
});

describe('parseAgentIdentity', () => {
  it('reads the agent field an MCP build sends', () => {
    expect(parseAgentIdentity({ id: 'x', pid: 42, client: 'codex' })).toEqual({ id: 'x', pid: 42, client: 'codex' });
  });

  it('treats a missing or malformed field as an older MCP build', () => {
    expect(parseAgentIdentity(undefined)).toBeNull();
    expect(parseAgentIdentity({ pid: 42 })).toBeNull();
    expect(parseAgentIdentity({ id: '' })).toBeNull();
    expect(parseAgentIdentity({ id: 'x'.repeat(200) })).toBeNull();
    expect(parseAgentIdentity({ id: 'x', pid: -1, client: 7 })).toEqual({ id: 'x', pid: null, client: null });
  });
});

describe('actingSessionId', () => {
  it('names the session of typing, clicking and closing requests only', () => {
    expect(actingSessionId('TerminalExecute', { session_id: 's' })).toBe('s');
    expect(actingSessionId('RdpClick', { connection_id: 'r' })).toBe('r');
    expect(actingSessionId('WebSessionNavigate', { session_id: 'w' })).toBe('w');
    expect(actingSessionId('ConnectionClose', { id: 'c' })).toBe('c');
    expect(actingSessionId('TerminalReadScreen', { session_id: 's' })).toBeNull();
    expect(actingSessionId('RdpScreenshot', { connection_id: 'r' })).toBeNull();
    expect(actingSessionId('WebSessionScreenshot', { session_id: 'w' })).toBeNull();
  });
});

describe('runWithAgentClaims', () => {
  it('refuses a second agent in a session the first one used, and says to open its own', async () => {
    await runWithAgentClaims(execute('ssh-1'), state, A, async () => OK);
    const dispatch = vi.fn(async () => OK);
    const refused = await runWithAgentClaims(execute('ssh-1'), state, B, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(refused).toEqual({
      type: 'Error',
      payload: { code: 'SESSION_IN_USE', reason: 'other_agent', message: sessionInUseMessage(A, 'ssh') },
    });
    expect((refused.payload as { message: string }).message).toContain('connection_open_entry');
    expect((refused.payload as { message: string }).message).toContain('claude-code');
  });

  it('still lets the second agent read the session', async () => {
    await runWithAgentClaims(execute('ssh-1'), state, A, async () => OK);
    const read = await runWithAgentClaims({ type: 'TerminalReadScreen', payload: { session_id: 'ssh-1', lines: 5 } }, state, B, async () => OK);
    expect(read).toBe(OK);
  });

  it('gives a new session to the agent that opened it', async () => {
    state.terminals.push('shell-2');
    await runWithAgentClaims({ type: 'LocalShellCreate', payload: {} }, state, B, async () => ({ type: 'Success', payload: { session_id: 'shell-2' } }));
    expect(ownerOf(state, 'shell-2', B)).toBe('you');
    expect(ownerOf(state, 'shell-2', A)).toBe('other_agent');
  });

  it('leaves user sessions free until an agent acts in them', () => {
    expect(ownerOf(state, 'shell-1', A)).toBe('free');
  });

  it('frees a session when its agent closes it', async () => {
    await runWithAgentClaims(execute('ssh-1'), state, A, async () => OK);
    await runWithAgentClaims({ type: 'ConnectionClose', payload: { id: 'ssh-1' } }, state, A, async () => OK);
    expect(ownerOf(state, 'ssh-1', B)).toBe('free');
  });

  it('refuses closing another agent\'s session', async () => {
    await runWithAgentClaims(execute('ssh-1'), state, A, async () => OK);
    const dispatch = vi.fn(async () => OK);
    const res = await runWithAgentClaims({ type: 'ConnectionClose', payload: { id: 'ssh-1' } }, state, B, dispatch);
    expect(res.type).toBe('Error');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('frees a session when its agent exits', async () => {
    await runWithAgentClaims(execute('ssh-1'), state, A, async () => OK);
    dead.add(A.pid!);
    expect((await runWithAgentClaims(execute('ssh-1'), state, B, async () => OK)).type).toBe('Success');
  });

  it('never claims or refuses older MCP builds that send no agent', async () => {
    await runWithAgentClaims(execute('ssh-1'), state, null, async () => OK);
    expect(ownerOf(state, 'ssh-1', A)).toBe('free');
    await runWithAgentClaims(execute('ssh-1'), state, A, async () => OK);
    expect((await runWithAgentClaims(execute('ssh-1'), state, null, async () => OK)).type).toBe('Success');
  });

  it('does not claim a session id that is not open', async () => {
    await runWithAgentClaims(execute('nope'), state, A, async () => OK);
    expect(ownerOf(state, 'nope', B)).toBe('free');
  });

  it('keeps every caller out of a CLI agent\'s own terminal', async () => {
    const dispatch = vi.fn(async () => OK);
    for (const agent of [A, null]) {
      const res = await runWithAgentClaims({ type: 'TerminalReadScreen', payload: { session_id: 'agent-pty' } }, state, agent, dispatch);
      expect(res.type).toBe('Error');
      expect((res.payload as { code: string }).code).toBe('NOT_FOUND');
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('tells an agent not to open a second RDP session', async () => {
    state.rdp.add('rdp-1');
    state.connections.set('rdp-1', { session_id: 'rdp-1', connection_type: 'rdp', host: 'win', port: 3389, created_at: 1 });
    await runWithAgentClaims({ type: 'RdpClick', payload: { connection_id: 'rdp-1', x: 1, y: 1 } }, state, A, async () => OK);
    const res = await runWithAgentClaims({ type: 'RdpType', payload: { connection_id: 'rdp-1', text: 'x' } }, state, B, async () => OK);
    const message = (res.payload as { message: string }).message;
    expect(message).toContain('RDP session');
    expect(message).toContain('Tell the user');
    expect(message).not.toContain('connection_open_entry');
  });
});

describe('openSessionsForEntry', () => {
  it('finds UI tabs by entry id and MCP sessions by host and default port', () => {
    state.rdp.add('entry-9').add('mcp-rdp');
    state.connections.set('entry-9', { session_id: 'entry-9', connection_type: 'rdp', host: 'other', port: 3389, created_at: 1 });
    state.connections.set('mcp-rdp', { session_id: 'mcp-rdp', connection_type: 'rdp', host: 'win', port: 3389, created_at: 1 });
    state.connections.set('closed', { session_id: 'closed', connection_type: 'rdp', host: 'win', port: 3389, created_at: 1 });
    expect(openSessionsForEntry(state, { id: 'entry-9', entry_type: 'rdp', host: 'win', port: null })).toEqual(['entry-9', 'mcp-rdp']);
  });
});

describe('pruneClosedSessions', () => {
  it('drops claims on sessions that closed', async () => {
    await runWithAgentClaims(execute('ssh-1'), state, A, async () => OK);
    state.terminals.splice(0, 1);
    pruneClosedSessions(state);
    state.terminals.push('ssh-1');
    expect(ownerOf(state, 'ssh-1', B)).toBe('free');
  });
});
