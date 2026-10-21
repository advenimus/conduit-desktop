import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { classifyNetError, probeTcp } from '../net-probe.js';

describe('classifyNetError', () => {
  it.each([
    ['ECONNREFUSED', 'refused'],
    ['ENOTFOUND', 'dns'],
    ['ECONNRESET', 'reset'],
    ['EHOSTUNREACH', 'unreachable'],
    ['ENETUNREACH', 'unreachable'],
    ['ETIMEDOUT', 'timeout'],
    [undefined, 'timeout'],
  ])('%s is %s', (code, result) => {
    expect(classifyNetError(code)).toBe(result);
  });
});

describe('probeTcp', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  it('finds an open port', async () => {
    server = createServer((s) => s.destroy());
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as { port: number }).port;
    expect(await probeTcp('127.0.0.1', port)).toBe('open');
  });

  it('finds a closed port', async () => {
    server = createServer();
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
    expect(await probeTcp('127.0.0.1', port)).toBe('refused');
  });
});
