// A plain TCP connect to the hop whose TLS failed with no OpenSSL reason: FreeRDP reports a closed port as a TLS failure.

import { connect as netConnect, type Socket } from 'node:net';
import type { RdpNetProbe } from './connect-error.js';

export const NET_PROBE_TIMEOUT_MS = 4_000;

export function classifyNetError(code: string | undefined): RdpNetProbe {
  switch (code) {
    case 'ECONNREFUSED':
      return 'refused';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_FAIL':
    case 'EAI_NONAME':
      return 'dns';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'reset';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
    case 'ENETDOWN':
    case 'EACCES':
    case 'EPERM':
    case 'EADDRNOTAVAIL':
      return 'unreachable';
    default:
      return 'timeout';
  }
}

type Connect = (options: { host: string; port: number }) => Socket;

export function probeTcp(host: string, port: number, timeoutMs = NET_PROBE_TIMEOUT_MS, connect: Connect = netConnect): Promise<RdpNetProbe> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (result: RdpNetProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.once('connect', () => finish('open'));
    socket.once('error', (err: NodeJS.ErrnoException) => finish(classifyNetError(err.code)));
  });
}
