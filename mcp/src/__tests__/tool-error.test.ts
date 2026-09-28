// @vitest-environment node
import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ConduitClient, IpcRequestError } from '../ipc-client.js';
import { toolErrorBody } from '../tool-error.js';

describe('toolErrorBody', () => {
  it('keeps the app error code and the open_elsewhere reason', () => {
    const err = new IpcRequestError('VAULT_LOCKED', 'This vault is open on another device. Open it here to use it.', 'open_elsewhere');
    expect(toolErrorBody(err)).toEqual({
      error: 'VAULT_LOCKED: This vault is open on another device. Open it here to use it.',
      code: 'VAULT_LOCKED',
      reason: 'open_elsewhere',
    });
  });

  it('adds only the code when the app gives no reason', () => {
    expect(toolErrorBody(new IpcRequestError('VAULT_LOCKED', 'Vault is locked'))).toEqual({ error: 'VAULT_LOCKED: Vault is locked', code: 'VAULT_LOCKED' });
  });

  it('keeps plain errors as they were', () => {
    expect(toolErrorBody(new Error('IPC request timed out'))).toEqual({ error: 'IPC request timed out' });
    expect(toolErrorBody('boom')).toEqual({ error: 'boom' });
  });
});

describe('ConduitClient error replies', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
    delete process.env.CONDUIT_SOCKET_PATH;
  });

  async function appReplying(reply: unknown): Promise<ConduitClient> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-ipc-'));
    const socketPath = path.join(dir, 's.sock');
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.end(`${JSON.stringify(reply)}\n`));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(() => {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    process.env.CONDUIT_SOCKET_PATH = socketPath;
    return ConduitClient.connect();
  }

  it('carries the reason of a VAULT_LOCKED reply', async () => {
    const client = await appReplying({ type: 'Error', payload: { code: 'VAULT_LOCKED', message: 'open elsewhere', reason: 'open_elsewhere' } });
    const err = await client.entryList().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcRequestError);
    expect(err).toMatchObject({ code: 'VAULT_LOCKED', reason: 'open_elsewhere', message: 'VAULT_LOCKED: open elsewhere' });
  });

  it('ignores a reason that is not a string', async () => {
    const client = await appReplying({ type: 'Error', payload: { code: 'VAULT_LOCKED', message: 'locked', reason: 42 } });
    const err = await client.credentialList().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'VAULT_LOCKED' });
    expect((err as IpcRequestError).reason).toBeUndefined();
  });
});
