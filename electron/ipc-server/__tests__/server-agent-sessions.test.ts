// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../../services/state.js', () => ({ AppState: { getInstance: () => ({ getMainWindow: () => null }) } }));
vi.mock('../../services/env-config.js', () => ({ getSocketPath: () => '/tmp/x.sock', isNamedPipe: () => false }));
vi.mock('../../services/ssh/resolve-auth.js', () => ({ resolveSshAuth: vi.fn(() => ({})), resolveSshAuthSystem: vi.fn(() => ({})) }));
vi.mock('../open-session.js', () => ({
  openSshSession: vi.fn(async () => ({ session_id: 'ssh-new', connection_type: 'ssh', host: '10.0.0.5', port: 22, status: 'connected' })),
  openRdpSession: vi.fn(async () => ({ session_id: 'rdp-new', connection_type: 'rdp', host: 'win', port: 3389, status: 'connected', width: 1, height: 1 })),
  openVncSession: vi.fn(),
  buildRdpEngineConfigFromEntry: vi.fn(() => ({})),
}));

const { handleRequest } = await import('../server.js');
const { resetSessionClaimsForTest, sessionClaims } = await import('../agent-sessions.js');
const { openRdpSession, openSshSession } = await import('../open-session.js');

const A = { id: 'agent-a', pid: 101, client: 'claude-code' };
const B = { id: 'agent-b', pid: 202, client: 'codex-mcp-client' };

const ENTRIES = [
  { id: 'e-ssh', name: 'Web server', entry_type: 'ssh', host: '10.0.0.5', port: 22, credential_id: null, config: {} },
  { id: 'e-rdp', name: 'Windows box', entry_type: 'rdp', host: 'win', port: null, credential_id: null, config: {} },
  { id: 'e-article', name: 'Overview', entry_type: 'document', host: null, port: null, credential_id: null, parent_entry_id: 'e-ssh', config: { kb: { scope: 'asset', kind: 'overview' } } },
];

function fakeState() {
  const terminals = new Set(['ssh-1']);
  const rdp = new Map<string, { getDimensions: () => { width: number; height: number } }>();
  const mcpConnections = new Map([
    ['ssh-1', { session_id: 'ssh-1', name: 'Web server', connection_type: 'ssh', host: '10.0.0.5', port: 22, status: 'connected', created_at: 1 }],
  ]);
  return {
    terminals,
    rdp,
    mcpConnections,
    getActiveVault: () => ({
      isUnlocked: () => true,
      listEntries: () => ENTRIES,
      getEntry: (id: string) => {
        const e = ENTRIES.find((x) => x.id === id);
        if (!e) throw new Error('not found');
        return e;
      },
      resolveCredential: () => null,
    }),
    terminalManager: {
      listSessions: () => [...terminals],
      isAgentTerminal: () => false,
      isConnected: (id: string) => terminals.has(id),
    },
    rdpManager: { get: (id: string) => rdp.get(id) },
    vncManager: { get: () => undefined },
    webManager: { listSessions: () => [] },
  };
}

type State = Parameters<typeof handleRequest>[1];
let state: ReturnType<typeof fakeState>;

const call = (type: string, payload: Record<string, unknown>, agent: unknown) =>
  handleRequest({ type, payload, agent }, state as unknown as State);

beforeEach(() => {
  vi.mocked(openRdpSession).mockClear();
  vi.mocked(openSshSession).mockClear();
  resetSessionClaimsForTest();
  state = fakeState();
  sessionClaims(state as never, { isProcessAlive: () => true });
});

describe('ConnectionList owner', () => {
  it('marks each active session as yours, another agent\'s, or free', async () => {
    sessionClaims(state as never).claim('ssh-1', A);
    const forA = await call('ConnectionList', {}, A);
    const forB = await call('ConnectionList', {}, B);
    const forOld = await call('ConnectionList', {}, undefined);
    const owner = (res: { payload: unknown }) => (res.payload as Array<{ id: string; owner?: string }>).find((c) => c.id === 'ssh-1')?.owner;
    expect(owner(forA)).toBe('you');
    expect(owner(forB)).toBe('other_agent');
    expect(owner(forOld)).toBe('other_agent');
    const saved = (forA.payload as Array<{ id: string; owner?: string; status: string }>).find((c) => c.id === 'e-rdp');
    expect(saved).toMatchObject({ status: 'disconnected' });
    expect(saved?.owner).toBeUndefined();
  });
});

describe('ConnectionList knowledge articles', () => {
  it('leaves knowledge articles out of the saved connections', async () => {
    const res = await call('ConnectionList', {}, A);
    expect((res.payload as Array<{ id: string }>).map((c) => c.id)).not.toContain('e-article');
  });
});

describe('ConnectionOpenEntry with other agents', () => {
  it('opens a new SSH session for the second agent instead of sharing the first one\'s', async () => {
    sessionClaims(state as never).claim('ssh-1', A);
    const res = await call('ConnectionOpenEntry', { entry_id: 'e-ssh' }, B);
    expect(res).toMatchObject({ type: 'Success', payload: { session_id: 'ssh-new', entry_id: 'e-ssh' } });
    expect(openSshSession).toHaveBeenCalledOnce();
    state.terminals.add('ssh-new');
    expect((await call('TerminalExecute', { session_id: 'ssh-1', command: 'ls' }, B)).payload).toMatchObject({ code: 'SESSION_IN_USE' });
  });

  it('returns the entry\'s free RDP session instead of a second login', async () => {
    state.rdp.set('e-rdp', { getDimensions: () => ({ width: 1280, height: 720 }) });
    state.mcpConnections.set('e-rdp', { session_id: 'e-rdp', name: 'Windows box', connection_type: 'rdp', host: 'win', port: 3389, status: 'connected', created_at: 2 });
    const res = await call('ConnectionOpenEntry', { entry_id: 'e-rdp' }, A);
    expect(res).toEqual({
      type: 'Success',
      payload: { session_id: 'e-rdp', connection_type: 'rdp', host: 'win', port: 3389, status: 'connected', width: 1280, height: 720, entry_id: 'e-rdp', name: 'Windows box', reused: true },
    });
    expect(openRdpSession).not.toHaveBeenCalled();
    expect(sessionClaims(state as never).ownerFor('e-rdp', A)).toBe('you');
  });

  it('refuses to open an RDP entry another agent is working in', async () => {
    state.rdp.set('e-rdp', { getDimensions: () => ({ width: 1, height: 1 }) });
    state.mcpConnections.set('e-rdp', { session_id: 'e-rdp', name: 'Windows box', connection_type: 'rdp', host: 'win', port: 3389, status: 'connected', created_at: 2 });
    sessionClaims(state as never).claim('e-rdp', A);
    const res = await call('ConnectionOpenEntry', { entry_id: 'e-rdp' }, B);
    expect(res.payload).toMatchObject({ code: 'SESSION_IN_USE', reason: 'other_agent' });
    expect(openRdpSession).not.toHaveBeenCalled();
  });

  it('opens RDP as before for older MCP builds and when nothing is open', async () => {
    expect((await call('ConnectionOpenEntry', { entry_id: 'e-rdp' }, A)).payload).toMatchObject({ session_id: 'rdp-new' });
    state.rdp.set('rdp-new', { getDimensions: () => ({ width: 1, height: 1 }) });
    state.mcpConnections.set('rdp-new', { session_id: 'rdp-new', name: 'Windows box', connection_type: 'rdp', host: 'win', port: 3389, status: 'connected', created_at: 3 });
    expect((await call('ConnectionOpenEntry', { entry_id: 'e-rdp' }, undefined)).payload).toMatchObject({ session_id: 'rdp-new' });
    expect(openRdpSession).toHaveBeenCalledTimes(2);
  });
});
