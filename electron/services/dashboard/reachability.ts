/**
 * "Is it up?" (docs/DASHBOARD.md 7.5): a direct TCP connect from this device to the entry's host
 * and port. Entries have no proxy or jump host settings, and the check uses the operating
 * system's name lookup. Host names are never logged.
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  REACHABILITY_MAX_CONCURRENT,
  REACHABILITY_MIN_INTERVAL_MS,
  REACHABILITY_TIMEOUT_MS,
  type ReachabilityResult,
  type ReachabilityStatus,
} from './dashboard-dto.js';

export interface ReachabilityEntry {
  readonly id: string;
  readonly entry_type: string;
  readonly host: string | null;
  readonly port: number | null;
}

export type ReachabilityTarget =
  | { readonly kind: 'target'; readonly host: string; readonly port: number }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'not_checkable' };

const DEFAULT_PORTS: Readonly<Record<string, number>> = { ssh: 22, rdp: 3389, vnc: 5900 };
const WEB_DEFAULT_PORTS: Readonly<Record<string, number>> = { 'https:': 443, 'http:': 80 };
const MAX_HOST_LENGTH = 253;
const DNS_LABEL_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

const INVALID: ReachabilityTarget = { kind: 'invalid' };
const NOT_CHECKABLE: ReachabilityTarget = { kind: 'not_checkable' };

export function isValidHost(host: string): boolean {
  if (host.length < 1 || host.length > MAX_HOST_LENGTH) return false;
  if (net.isIP(host) !== 0) return true;
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  return name.length > 0 && name.split('.').every((label) => DNS_LABEL_RE.test(label));
}

export function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function checked(host: string, port: unknown): ReachabilityTarget {
  const trimmed = host.trim();
  return isValidHost(trimmed) && isValidPort(port) ? { kind: 'target', host: trimmed, port } : INVALID;
}

function webTarget(raw: string): ReachabilityTarget {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(SCHEME_RE.test(text) ? text : `https://${text}`);
  } catch {
    return INVALID;
  }
  const fallback = WEB_DEFAULT_PORTS[url.protocol];
  if (fallback === undefined) return INVALID;
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return checked(hostname, url.port === '' ? fallback : Number(url.port));
}

export function reachabilityTarget(entry: ReachabilityEntry): ReachabilityTarget {
  const host = entry.host?.trim() ?? '';
  if (entry.entry_type === 'web') return host === '' ? INVALID : webTarget(host);
  const fallback = DEFAULT_PORTS[entry.entry_type];
  if (fallback === undefined) return NOT_CHECKABLE;
  if (host === '') return INVALID;
  return checked(host, entry.port ?? fallback);
}

// ---------- the TCP probe ----------

/** The part of net.Socket the probe uses (tests pass a fake). */
export interface ProbeSocket extends EventEmitter {
  destroy(): void;
}

export type SocketFactory = (options: { host: string; port: number }) => ProbeSocket;

export interface ProbeResult {
  readonly status: Exclude<ReachabilityStatus, 'invalid' | 'not_checkable'>;
  readonly latencyMs: number | null;
}

const ERROR_STATUS: Readonly<Record<string, ProbeResult['status']>> = {
  ECONNREFUSED: 'refused',
  ENOTFOUND: 'not_found',
  EAI_AGAIN: 'not_found',
  EAI_NONAME: 'not_found',
  ETIMEDOUT: 'timeout',
};

export function statusForError(err: unknown): ProbeResult['status'] {
  const code = (err as { code?: unknown } | null)?.code;
  return (typeof code === 'string' ? ERROR_STATUS[code] : undefined) ?? 'unreachable';
}

const netSocket: SocketFactory = ({ host, port }) => net.connect({ host, port });

/** One timer covers the name lookup and the connect. The socket is always destroyed. */
export function probe(
  host: string,
  port: number,
  connect: SocketFactory = netSocket,
  timeoutMs: number = REACHABILITY_TIMEOUT_MS,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let socket: ProbeSocket | null = null;
    let settled = false;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.removeAllListeners();
      socket?.on('error', () => {});
      socket?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: 'timeout', latencyMs: null }), timeoutMs);
    try {
      socket = connect({ host, port });
    } catch (err) {
      finish({ status: statusForError(err), latencyMs: null });
      return;
    }
    socket.once('connect', () => finish({ status: 'reachable', latencyMs: Date.now() - startedAt }));
    socket.once('error', (err: unknown) => finish({ status: statusForError(err), latencyMs: null }));
  });
}

// ---------- queue, cache and in-flight sharing ----------

export interface ReachabilityCheckerOptions {
  readonly probe?: (host: string, port: number) => Promise<ProbeResult>;
  readonly now?: () => number;
  readonly maxConcurrent?: number;
  readonly minIntervalMs?: number;
}

interface CachedResult {
  readonly result: ReachabilityResult;
  readonly atMs: number;
}

export class ReachabilityChecker {
  private readonly probeFn: (host: string, port: number) => Promise<ProbeResult>;
  private readonly now: () => number;
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;
  private readonly inFlight = new Map<string, Promise<ReachabilityResult>>();
  private readonly cache = new Map<string, CachedResult>();
  private readonly waiting: Array<() => void> = [];
  private running = 0;

  constructor(opts: ReachabilityCheckerOptions = {}) {
    this.probeFn = opts.probe ?? ((host, port) => probe(host, port));
    this.now = opts.now ?? Date.now;
    this.maxConcurrent = opts.maxConcurrent ?? REACHABILITY_MAX_CONCURRENT;
    this.minIntervalMs = opts.minIntervalMs ?? REACHABILITY_MIN_INTERVAL_MS;
  }

  check(entry: ReachabilityEntry): Promise<ReachabilityResult> {
    const cached = this.cache.get(entry.id);
    if (cached && this.now() - cached.atMs < this.minIntervalMs) return Promise.resolve(cached.result);
    const pending = this.inFlight.get(entry.id);
    if (pending) return pending;
    const promise = this.run(entry).finally(() => this.inFlight.delete(entry.id));
    this.inFlight.set(entry.id, promise);
    return promise;
  }

  private async run(entry: ReachabilityEntry): Promise<ReachabilityResult> {
    const target = reachabilityTarget(entry);
    const result =
      target.kind === 'target'
        ? await this.probeQueued(entry.id, target.host, target.port)
        : this.result(entry.id, target.kind, null, null, null);
    this.cache.set(entry.id, { result, atMs: this.now() });
    return result;
  }

  private async probeQueued(entryId: string, host: string, port: number): Promise<ReachabilityResult> {
    await this.acquire();
    try {
      const { status, latencyMs } = await this.probeFn(host, port);
      return this.result(entryId, status, host, port, latencyMs);
    } finally {
      this.release();
    }
  }

  private result(
    entryId: string,
    status: ReachabilityStatus,
    host: string | null,
    port: number | null,
    latencyMs: number | null,
  ): ReachabilityResult {
    return { entryId, status, host, port, latencyMs, checkedAt: new Date(this.now()).toISOString() };
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Hands the slot straight to the next waiter, in order. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }
}
