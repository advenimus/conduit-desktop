// A TCP proxy the harness controls, so one device can lose Supabase while the shared local stack
// keeps running for everyone else. Point a device at it with CONDUIT_DEV_SUPABASE_URL (proxy.env).
// cut() resets every open connection (HTTP keep-alive and Realtime websockets alike) and resets new
// ones on accept; restore() lets connections through again.

import net from 'node:net';

const RESERVED_PORTS = new Set([1420, 54321, 54322, 54323, 54324]);
const LISTEN_ATTEMPTS = 20;

function listenOnce(server, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port: 0, host, exclusive: true });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function listenOutsideReserved(server, host) {
  for (let i = 0; i < LISTEN_ATTEMPTS; i++) {
    const port = await listenOnce(server, host);
    if (!RESERVED_PORTS.has(port)) return port;
    await closeServer(server);
  }
  throw new Error(`net-proxy: no free port outside ${[...RESERVED_PORTS].join(', ')} after ${LISTEN_ATTEMPTS} attempts`);
}

/**
 * Starts a proxy on 127.0.0.1:<free port> to `targetHost:targetPort`.
 * Returns {port, url, env, cut(), restore(), isCut(), stats(), close()}.
 */
export async function startNetProxy(targetPort, { targetHost = '127.0.0.1', host = '127.0.0.1' } = {}) {
  if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) throw new Error(`net-proxy: bad target port ${targetPort}`);
  const pairs = new Set();
  const counts = { accepted: 0, refused: 0, reset: 0 };
  let cutNow = false;
  let closed = false;

  const server = net.createServer((client) => {
    if (cutNow || closed) {
      counts.refused += 1;
      client.resetAndDestroy();
      return;
    }
    counts.accepted += 1;
    const upstream = net.connect({ port: targetPort, host: targetHost });
    const pair = { client, upstream };
    pairs.add(pair);
    const drop = () => {
      if (!pairs.delete(pair)) return;
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', drop);
    upstream.on('close', drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.on('error', () => {});

  const port = await listenOutsideReserved(server, host);
  const url = `http://${host}:${port}`;

  function resetAll() {
    for (const pair of [...pairs]) {
      pairs.delete(pair);
      counts.reset += 1;
      pair.client.resetAndDestroy();
      pair.upstream.destroy();
    }
  }

  return {
    port,
    url,
    /** Environment for launchDevice: the device's Supabase goes through this proxy. */
    env: { CONDUIT_DEV_SUPABASE_URL: url },
    /** Supabase unreachable: open connections are reset, new ones reset on accept. */
    cut() {
      cutNow = true;
      resetAll();
    },
    restore() {
      if (closed) throw new Error('net-proxy: restore() after close()');
      cutNow = false;
    },
    isCut: () => cutNow,
    /** {accepted, refused, reset, open}: connections passed, refused while cut, reset by cut(), open now. */
    stats: () => ({ ...counts, open: pairs.size }),
    async close() {
      if (closed) return;
      closed = true;
      resetAll();
      await closeServer(server);
    },
  };
}
