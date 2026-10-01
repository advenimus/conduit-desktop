// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ConduitClient } from '../ipc-client.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-agent-'));
const socketPath = path.join(dir, 'conduit.sock');
let server: net.Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  delete process.env.CONDUIT_SOCKET_PATH;
});

/** A one-request app stub that records each request line it receives. */
async function stubApp(received: Array<Record<string, unknown>>): Promise<void> {
  server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      received.push(JSON.parse(data.slice(0, data.indexOf('\n'))));
      socket.end(JSON.stringify({ type: 'Success', payload: [] }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  process.env.CONDUIT_SOCKET_PATH = socketPath;
}

describe('ConduitClient agent identity', () => {
  it('sends the same agent id, its pid and the MCP client name with every request', async () => {
    const received: Array<Record<string, unknown>> = [];
    await stubApp(received);
    const client = await ConduitClient.connect();
    await client.connectionList();
    client.setClientName('codex-mcp-client');
    await client.connectionList();

    expect(received).toHaveLength(2);
    const [first, second] = received.map((r) => r.agent as { id: string; pid: number; client: string | null });
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).toEqual({ id: first.id, pid: process.pid, client: null });
    expect(second).toEqual({ id: first.id, pid: process.pid, client: 'codex-mcp-client' });
    expect(received[0]).toMatchObject({ type: 'ConnectionList', payload: {} });
  });

  it('gives each MCP process its own agent id', async () => {
    await stubApp([]);
    const a = await ConduitClient.connect();
    const b = await ConduitClient.connect();
    expect(a.agentIdentity.id).not.toBe(b.agentIdentity.id);
  });
});
