import { describe, it, expect, vi } from 'vitest';
import { isRemoteSessionEnd } from '../session-end.js';
import { parseHelperDisconnect } from '../engines/helper-protocol.js';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('sharp', () => ({ default: vi.fn() }));
const engineHolder = vi.hoisted(() => ({ onClose: null as null | ((error: string | null, details?: { endedByRemote: boolean }) => void) }));
vi.mock('../engines/factory.js', () => ({
  createRdpEngine: () => ({
    connect: (_cfg: unknown, _bitmap: unknown, onClose: typeof engineHolder.onClose) => {
      engineHolder.onClose = onClose;
      return Promise.resolve({ width: 800, height: 600 });
    },
  }),
}));

const { RdpSession } = await import('../session.js');

describe('isRemoteSessionEnd', () => {
  it('is true for a sign-out or a disconnect the server side asked for', () => {
    for (const code of [0x1, 0x2, 0xb, 0xc]) expect(isRemoteSessionEnd(code)).toBe(true);
  });

  it('is false for no reason and for real errors', () => {
    for (const code of [null, 0, 0x3, 0x4, 0x5, 0x7, 0x10c9]) expect(isRemoteSessionEnd(code)).toBe(false);
  });
});

describe('parseHelperDisconnect', () => {
  it('reads the error and the server reason', () => {
    expect(parseHelperDisconnect(Buffer.from('{"error":null,"errorInfo":12}'))).toEqual({ error: null, errorInfo: 12 });
    expect(parseHelperDisconnect(Buffer.from('{"error":"boom"}'))).toEqual({ error: 'boom', errorInfo: null });
  });

  it('keeps raw text from an old or broken helper as the error', () => {
    expect(parseHelperDisconnect(Buffer.from('gone'))).toEqual({ error: 'gone', errorInfo: null });
    expect(parseHelperDisconnect(Buffer.from(''))).toEqual({ error: null, errorInfo: null });
  });
});

describe('RdpSession close status', () => {
  async function connected() {
    const sent: Array<[string, Record<string, unknown>]> = [];
    const session = new RdpSession('s1', {
      host: 'h', port: 3389, username: 'u', password: 'p', width: 800, height: 600, enableNla: false, skipCertVerification: true,
    });
    session.setWindow({ isDestroyed: () => false, webContents: { send: (c: string, p: Record<string, unknown>) => sent.push([c, p]) } } as never);
    await session.connect();
    return sent;
  }

  it('tells the window the session ended on purpose after a sign-out', async () => {
    const sent = await connected();
    engineHolder.onClose!(null, { endedByRemote: true });
    expect(sent).toContainEqual(['rdp:status', { sessionId: 's1', status: 'disconnected', error: null, ended: true }]);
  });

  it('reports a dropped link as a disconnect, not an end', async () => {
    const sent = await connected();
    engineHolder.onClose!(null);
    expect(sent).toContainEqual(['rdp:status', { sessionId: 's1', status: 'disconnected', error: null, ended: false }]);
  });
});
