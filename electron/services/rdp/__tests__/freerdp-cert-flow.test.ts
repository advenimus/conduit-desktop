// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { parseRdpConnectError } from '../connect-error.js';
import type { RdpEngineConfig } from '../engine.js';

// A stand-in helper: it reads the connect line, then plays the script given in FAKE_HELPER_SCRIPT.
const FAKE_HELPER = `#!/usr/bin/env node
const readline = require('node:readline');
const frame = (type, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  const head = Buffer.alloc(8);
  head.writeUInt32LE(type, 0);
  head.writeUInt32LE(body.length, 4);
  process.stdout.write(Buffer.concat([head, body]));
};
const lines = readline.createInterface({ input: process.stdin });
const script = process.env.FAKE_HELPER_SCRIPT;
lines.on('line', (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === 'connect') {
    if (script === 'tls-no-reason') {
      frame(0xff, { message: 'The connection failed at TLS connect.', code: 131080 });
    } else {
      frame(0x0e, { id: 5, host: 'rdg.example.com', port: 443, hop: 'gateway', mismatch: false, changed: false, pem: 'PEM' });
    }
  } else if (cmd.type === 'cert_response') {
    if (cmd.id === 5 && cmd.accept) frame(0x01, { width: 800, height: 600 });
    else frame(0xff, { message: 'The connection failed at TLS connect.', code: 131080, phase: 'gateway' });
  } else if (cmd.type === 'disconnect') {
    process.exit(0);
  }
});
`;

let dir: string;
let helper: string;

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nowhere' } }));
vi.mock('../engines/factory.js', () => ({ getFreeRdpBinaryPath: () => helper }));
vi.mock('../../env-config.js', () => ({ getDataDir: () => dir }));
vi.mock('../../dns-resolver.js', () => ({ resolveHostname: async () => undefined }));

const { FreeRdpEngine } = await import('../engines/freerdp.js');

const base: RdpEngineConfig = {
  host: '127.0.0.1',
  port: 3389,
  username: 'u',
  password: 'p',
  width: 800,
  height: 600,
  enableNla: true,
  skipCertVerification: false,
};

function connect(config: RdpEngineConfig, script: string) {
  process.env.FAKE_HELPER_SCRIPT = script;
  const engine = new FreeRdpEngine();
  const result = engine.connect(config, () => {}, () => {});
  return { engine, result };
}

describe.skipIf(process.platform === 'win32')('FreeRdpEngine certificate questions', () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-engine-'));
    helper = path.join(dir, 'fake-helper');
    fs.writeFileSync(helper, FAKE_HELPER, { mode: 0o755 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.FAKE_HELPER_SCRIPT;
  });

  it('connects when the verifier trusts the certificate', async () => {
    const verify = vi.fn(async () => ({ accept: true as const }));
    const { engine, result } = connect({ ...base, verifyCertificate: verify }, 'cert');
    await expect(result).resolves.toEqual({ width: 800, height: 600 });
    expect(verify).toHaveBeenCalledWith(
      { id: 5, host: 'rdg.example.com', port: 443, hop: 'gateway', mismatch: false, changed: false, pem: 'PEM' },
      expect.any(AbortSignal),
    );
    await engine.close();
  });

  it('fails with the verifier\'s own words when it does not trust the certificate', async () => {
    const verify = async () => ({ accept: false as const, message: 'You did not trust the certificate of the gateway rdg.example.com:443.' });
    const { engine, result } = connect({ ...base, verifyCertificate: verify }, 'cert');
    const err = await result.catch((e: Error) => e);
    expect(parseRdpConnectError((err as Error).message)).toEqual({
      message: 'You did not trust the certificate of the gateway rdg.example.com:443.',
      phase: 'gateway',
      certRejected: true,
    });
    await engine.close();
  });

  it('refuses a certificate when there is no verifier', async () => {
    const { engine, result } = connect(base, 'cert');
    const err = await result.catch((e: Error) => e);
    expect(parseRdpConnectError((err as Error).message).certRejected).toBe(true);
    await engine.close();
  });

  it('checks the port when TLS failed without a reason', async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((done) => server.close(() => done()));

    const { engine, result } = connect({ ...base, port }, 'tls-no-reason');
    const err = await result.catch((e: Error) => e);
    expect(parseRdpConnectError((err as Error).message)).toMatchObject({ code: 131080, net: 'refused' });
    await engine.close();
  });
});
