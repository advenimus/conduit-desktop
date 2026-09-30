// @vitest-environment node
import dns from 'node:dns';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ReachabilityChecker,
  isValidHost,
  probe,
  reachabilityTarget,
  startProbe,
  statusForError,
  type ProbeResult,
  type ProbeRun,
  type ProbeSocket,
  type ReachabilityEntry,
} from '../reachability.js';

function entry(entry_type: string, host: string | null, port: number | null = null, id = 'e1'): ReachabilityEntry {
  return { id, entry_type, host, port };
}

class FakeSocket extends EventEmitter implements ProbeSocket {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

function done(result: Promise<ProbeResult>): ProbeRun {
  return { result, idle: result.then(() => undefined) };
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reachabilityTarget', () => {
  it('uses the entry port or the protocol default for ssh, rdp and vnc', () => {
    expect(reachabilityTarget(entry('ssh', 'web01.example.com'))).toEqual({ kind: 'target', host: 'web01.example.com', port: 22 });
    expect(reachabilityTarget(entry('ssh', ' 10.0.0.5 ', 2222))).toEqual({ kind: 'target', host: '10.0.0.5', port: 2222 });
    expect(reachabilityTarget(entry('rdp', 'dc01'))).toEqual({ kind: 'target', host: 'dc01', port: 3389 });
    expect(reachabilityTarget(entry('vnc', 'box.local'))).toEqual({ kind: 'target', host: 'box.local', port: 5900 });
  });

  it('parses web hosts as URLs with the scheme default port', () => {
    expect(reachabilityTarget(entry('web', 'intranet.example.com'))).toEqual({ kind: 'target', host: 'intranet.example.com', port: 443 });
    expect(reachabilityTarget(entry('web', 'http://intranet/path'))).toEqual({ kind: 'target', host: 'intranet', port: 80 });
    expect(reachabilityTarget(entry('web', 'https://127.0.0.1:8443/x'))).toEqual({ kind: 'target', host: '127.0.0.1', port: 8443 });
    expect(reachabilityTarget(entry('web', 'localhost:3000'))).toEqual({ kind: 'target', host: 'localhost', port: 3000 });
    expect(reachabilityTarget(entry('web', 'http://[::1]:8080/'))).toEqual({ kind: 'target', host: '::1', port: 8080 });
  });

  it('marks other schemes, missing hosts and bad values invalid', () => {
    expect(reachabilityTarget(entry('web', 'ftp://files.example.com'))).toEqual({ kind: 'invalid' });
    expect(reachabilityTarget(entry('web', 'http://'))).toEqual({ kind: 'invalid' });
    expect(reachabilityTarget(entry('web', null))).toEqual({ kind: 'invalid' });
    expect(reachabilityTarget(entry('ssh', null))).toEqual({ kind: 'invalid' });
    expect(reachabilityTarget(entry('ssh', '   '))).toEqual({ kind: 'invalid' });
    expect(reachabilityTarget(entry('ssh', 'host name'))).toEqual({ kind: 'invalid' });
    expect(reachabilityTarget(entry('ssh', 'host', 0))).toEqual({ kind: 'invalid' });
    expect(reachabilityTarget(entry('ssh', 'host', 65536))).toEqual({ kind: 'invalid' });
    expect(reachabilityTarget(entry('ssh', 'host', 22.5))).toEqual({ kind: 'invalid' });
  });

  it('marks command, document and credential not checkable', () => {
    for (const t of ['command', 'document', 'credential']) expect(reachabilityTarget(entry(t, 'host'))).toEqual({ kind: 'not_checkable' });
  });
});

describe('isValidHost', () => {
  it('accepts IPs and DNS names with letters, digits, - and _', () => {
    for (const h of ['10.0.0.1', '::1', 'fe80::1', 'a', 'my_host', 'web-01.example.com', 'example.com.', `${'a'.repeat(63)}.com`]) {
      expect(isValidHost(h)).toBe(true);
    }
  });

  it('rejects empty, long, dashed-edge and odd names', () => {
    for (const h of ['', '-web', 'web-', 'a..b', 'we b', 'host:22', 'ex!ample', `${'a'.repeat(64)}.com`, `${'a.'.repeat(127)}ab`]) {
      expect(isValidHost(h)).toBe(false);
    }
  });
});

describe('probe error mapping', () => {
  const cases: Array<[string, ProbeResult['status']]> = [
    ['ECONNREFUSED', 'refused'],
    ['ENOTFOUND', 'not_found'],
    ['EAI_AGAIN', 'not_found'],
    ['EAI_NONAME', 'not_found'],
    ['ETIMEDOUT', 'timeout'],
    ['EHOSTUNREACH', 'unreachable'],
    ['ENETUNREACH', 'unreachable'],
    ['EHOSTDOWN', 'unreachable'],
    ['ENETDOWN', 'unreachable'],
    ['ESOMETHING', 'unreachable'],
  ];

  it.each(cases)('%s gives %s and destroys the socket', async (code, status) => {
    const socket = new FakeSocket();
    const pending = probe('h', 1, () => socket, 3000);
    socket.emit('error', errno(code));
    await expect(pending).resolves.toEqual({ status, latencyMs: null });
    expect(socket.destroyed).toBe(true);
  });

  it('maps a thrown connect and a non-error value to statuses', async () => {
    await expect(probe('h', 1, () => { throw errno('ENOTFOUND'); }, 3000)).resolves.toEqual({ status: 'not_found', latencyMs: null });
    expect(statusForError('boom')).toBe('unreachable');
  });

  it('times out after the timer and destroys the socket', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const pending = probe('h', 1, () => socket, 3000);
    await vi.advanceTimersByTimeAsync(2999);
    expect(socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ status: 'timeout', latencyMs: null });
    expect(socket.destroyed).toBe(true);
    socket.emit('connect');
    socket.emit('error', errno('ECONNRESET'));
  });

  it('reports reachable with a latency on connect', async () => {
    const socket = new FakeSocket();
    const pending = probe('h', 1, () => socket, 3000);
    socket.emit('connect');
    const res = await pending;
    expect(res.status).toBe('reachable');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(socket.destroyed).toBe(true);
  });
});

describe('probe name lookup', () => {
  type LookupCallback = Parameters<net.LookupFunction>[2];

  function stalledLookup() {
    const pending: Array<{ hostname: string; callback: LookupCallback }> = [];
    const lookup: net.LookupFunction = (hostname, _options, callback) => {
      pending.push({ hostname, callback });
    };
    return { pending, lookup };
  }

  it('stays busy after the timeout until a stalled lookup returns', async () => {
    vi.useFakeTimers();
    const { pending, lookup } = stalledLookup();
    const socket = new FakeSocket();
    const run = startProbe('slow.example', 22, {
      lookup,
      timeoutMs: 3000,
      connect: (opts) => {
        opts.lookup(opts.host, {}, () => {});
        return socket;
      },
    });
    let idle = false;
    void run.idle.then(() => {
      idle = true;
    });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(run.result).resolves.toEqual({ status: 'timeout', latencyMs: null });
    expect(socket.destroyed).toBe(true);
    expect(idle).toBe(false);
    expect(pending.map((p) => p.hostname)).toEqual(['slow.example']);
    pending[0].callback(errno('EAI_AGAIN'), '', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toBe(true);
  });

  it('is idle with the result when no lookup ran', async () => {
    const socket = new FakeSocket();
    const run = startProbe('10.0.0.1', 22, { connect: () => socket, timeoutMs: 3000 });
    socket.emit('connect');
    await expect(run.result).resolves.toMatchObject({ status: 'reachable' });
    await expect(run.idle).resolves.toBeUndefined();
  });

  it('passes the lookup answer through to the socket', async () => {
    const lookup: net.LookupFunction = (_h, _o, callback) => callback(null, '10.0.0.9', 4);
    let answer: unknown[] = [];
    const socket = new FakeSocket();
    const run = startProbe('web01', 22, {
      lookup,
      connect: (opts) => {
        opts.lookup('web01', {}, (...args) => {
          answer = args;
        });
        return socket;
      },
    });
    expect(answer).toEqual([null, '10.0.0.9', 4]);
    socket.emit('error', errno('ECONNREFUSED'));
    await expect(run.result).resolves.toEqual({ status: 'refused', latencyMs: null });
    await expect(run.idle).resolves.toBeUndefined();
  });
});

describe('probe against a real loopback server', () => {
  it('gives reachable for a listening port and refused for a closed one', async () => {
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const openPort = (server.address() as net.AddressInfo).port;
    try {
      const up = await probe('127.0.0.1', openPort);
      expect(up.status).toBe('reachable');
      expect(up.latencyMs).not.toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await expect(probe('127.0.0.1', openPort)).resolves.toEqual({ status: 'refused', latencyMs: null });
  });

  it('resolves a name through the system lookup and becomes idle', async () => {
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const lookups: string[] = [];
    const lookup: net.LookupFunction = (hostname, options, callback) => {
      lookups.push(hostname);
      dns.lookup(hostname, { ...options, family: 4 }, callback as never);
    };
    try {
      const run = startProbe('localhost', port, { lookup });
      await expect(run.result).resolves.toMatchObject({ status: 'reachable' });
      await expect(run.idle).resolves.toBeUndefined();
      expect(lookups).toEqual(['localhost']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('ReachabilityChecker', () => {
  function deferredProbe() {
    const calls: Array<{ host: string; port: number; resolve: (r: ProbeResult) => void }> = [];
    const fn = (host: string, port: number) =>
      done(
        new Promise<ProbeResult>((resolve) => {
          calls.push({ host, port, resolve });
        }),
      );
    return { calls, fn };
  }

  const up: ProbeResult = { status: 'reachable', latencyMs: 5 };

  it('builds the result with the checked host, port and time', async () => {
    const checker = new ReachabilityChecker({ probe: () => done(Promise.resolve(up)), now: () => Date.parse('2026-09-29T12:00:00.000Z') });
    await expect(checker.check(entry('ssh', 'web01', 2222))).resolves.toEqual({
      entryId: 'e1', status: 'reachable', host: 'web01', port: 2222, latencyMs: 5, checkedAt: '2026-09-29T12:00:00.000Z',
    });
    await expect(checker.check(entry('command', 'x', null, 'e2'))).resolves.toMatchObject({ status: 'not_checkable', host: null, port: null, latencyMs: null });
    await expect(checker.check(entry('ssh', 'bad host', null, 'e3'))).resolves.toMatchObject({ status: 'invalid', host: null, port: null });
  });

  it('runs at most four probes at once, the rest in order', async () => {
    const { calls, fn } = deferredProbe();
    const checker = new ReachabilityChecker({ probe: fn });
    const results = Array.from({ length: 6 }, (_, i) => checker.check(entry('ssh', `h${i}`, null, `e${i}`)));
    await Promise.resolve();
    expect(calls.map((c) => c.host)).toEqual(['h0', 'h1', 'h2', 'h3']);
    calls[2].resolve(up);
    await vi.waitFor(() => expect(calls).toHaveLength(5));
    expect(calls[4].host).toBe('h4');
    calls[0].resolve(up);
    await vi.waitFor(() => expect(calls).toHaveLength(6));
    expect(calls[5].host).toBe('h5');
    for (const c of calls) c.resolve(up);
    await expect(Promise.all(results)).resolves.toHaveLength(6);
  });

  it('shares an in-flight check of the same entry', async () => {
    const { calls, fn } = deferredProbe();
    const checker = new ReachabilityChecker({ probe: fn });
    const a = checker.check(entry('ssh', 'h'));
    const b = checker.check(entry('ssh', 'h'));
    expect(a).toBe(b);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    calls[0].resolve(up);
    await expect(a).resolves.toMatchObject({ status: 'reachable' });
  });

  it('holds the slot of a timed-out probe until its lookup returns', async () => {
    const idles: Array<() => void> = [];
    const started: string[] = [];
    const timedOut: ProbeResult = { status: 'timeout', latencyMs: null };
    const checker = new ReachabilityChecker({
      probe: (host) => {
        started.push(host);
        return { result: Promise.resolve(timedOut), idle: new Promise<void>((resolve) => idles.push(resolve)) };
      },
    });
    const results = Array.from({ length: 5 }, (_, i) => checker.check(entry('ssh', `h${i}`, null, `e${i}`)));
    await Promise.all(results.slice(0, 4));
    expect(started).toEqual(['h0', 'h1', 'h2', 'h3']);
    idles[1]();
    await vi.waitFor(() => expect(started).toHaveLength(5));
    expect(started[4]).toBe('h4');
    for (const release of idles) release();
    await expect(results[4]).resolves.toMatchObject({ status: 'timeout' });
  });

  it('checks again when the host, port or type changes', async () => {
    const probeFn = vi.fn(() => done(Promise.resolve(up)));
    const checker = new ReachabilityChecker({ probe: probeFn, now: () => 1_000_000 });
    await checker.check(entry('ssh', 'old-host'));
    await expect(checker.check(entry('ssh', 'new-host'))).resolves.toMatchObject({ host: 'new-host' });
    await expect(checker.check(entry('ssh', 'new-host', 2222))).resolves.toMatchObject({ port: 2222 });
    await expect(checker.check(entry('rdp', 'new-host', 2222))).resolves.toMatchObject({ port: 2222 });
    expect(probeFn).toHaveBeenCalledTimes(4);
    await checker.check(entry('rdp', 'new-host', 2222));
    expect(probeFn).toHaveBeenCalledTimes(4);
  });

  it('returns the last result within two seconds, then checks again', async () => {
    let nowMs = 1_000_000;
    const probeFn = vi.fn(() => done(Promise.resolve(up)));
    const checker = new ReachabilityChecker({ probe: probeFn, now: () => nowMs });
    const first = await checker.check(entry('ssh', 'h'));
    nowMs += 1999;
    await expect(checker.check(entry('ssh', 'h'))).resolves.toBe(first);
    expect(probeFn).toHaveBeenCalledTimes(1);
    nowMs += 1;
    await checker.check(entry('ssh', 'h'));
    expect(probeFn).toHaveBeenCalledTimes(2);
  });
});
