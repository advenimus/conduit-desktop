// Speaks the conduit-freerdp helper protocol (see electron/services/rdp/engines/freerdp.ts):
// stdin takes one JSON command per line, stdout sends [type:u32-LE][length:u32-LE][payload] frames.

export const MSG = Object.freeze({
  CONNECTED: 0x01,
  BITMAP_UPDATE: 0x02,
  DISCONNECTED: 0x03,
  RESIZED: 0x04,
  CURSOR_SET: 0x0b,
  CURSOR_NULL: 0x0c,
  CURSOR_DEFAULT: 0x0d,
  CERT_VERIFY: 0x0e,
  ERROR: 0xff,
});

export const TLS_CONNECT_FAILED = 0x00020008;

// Same text as LEGACY_OPENSSL_CONF in electron/services/rdp/cert-trust/helper-tls-files.ts (a test keeps them equal).
export const LEGACY_OPENSSL_CONF = `openssl_conf = conduit_conf

[conduit_conf]
ssl_conf = ssl_sect

[ssl_sect]
system_default = system_default_sect

[system_default_sect]
Options = UnsafeLegacyServerConnect
`;

export function buildConnectCommand({
  host,
  port,
  username,
  password,
  domain = '',
  width = 1024,
  height = 768,
  enableNla = true,
  skipCertVerification = true,
  legacyTls = false,
  gateway,
}) {
  const config = {
    host,
    port,
    username,
    password,
    domain,
    width,
    height,
    enableNla,
    skipCertVerification,
    enableGfx: true,
    enableH264: true,
    drives: [],
    desktopScaleFactor: 100,
    deviceScaleFactor: 100,
    enableClipboard: true,
    legacyTls,
  };
  if (gateway) {
    config.gateway = {
      host: gateway.host,
      port: gateway.port,
      username: gateway.username,
      password: gateway.password,
      domain: gateway.domain ?? '',
      transport: gateway.transport ?? 'auto',
      bypassLocal: gateway.bypassLocal ?? false,
      legacyTls: gateway.legacyTls ?? false,
    };
  }
  return JSON.stringify({ type: 'connect', config }) + '\n';
}

export function createFrameParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return {
    feed(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length >= 8) {
        const type = buffer.readUInt32LE(0);
        const length = buffer.readUInt32LE(4);
        if (buffer.length < 8 + length) break;
        const payload = buffer.subarray(8, 8 + length);
        buffer = buffer.subarray(8 + length);
        onMessage(type, payload);
      }
    },
  };
}

function parseJson(payload) {
  try {
    return { ok: true, value: JSON.parse(payload.toString('utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}

export function decodeMessage(type, payload) {
  switch (type) {
    case MSG.CONNECTED:
    case MSG.RESIZED: {
      const { ok, value } = parseJson(payload);
      const kind = type === MSG.CONNECTED ? 'connected' : 'resized';
      return ok ? { kind, width: value.width, height: value.height } : { kind, width: 0, height: 0 };
    }
    case MSG.BITMAP_UPDATE: {
      if (payload.length < 8) return { kind: 'bitmap', x: 0, y: 0, width: 0, height: 0 };
      return {
        kind: 'bitmap',
        x: payload.readUInt16LE(0),
        y: payload.readUInt16LE(2),
        width: payload.readUInt16LE(4),
        height: payload.readUInt16LE(6),
      };
    }
    case MSG.ERROR: {
      const { ok, value } = parseJson(payload);
      const clean = ok && value !== null && typeof value.message === 'string' && value.message.length > 0;
      const msg = { kind: 'error', message: clean ? value.message : payload.toString('utf8'), clean };
      if (clean && typeof value.code === 'number') msg.code = value.code;
      if (clean && typeof value.tls === 'string') msg.tls = value.tls;
      return msg;
    }
    case MSG.CERT_VERIFY: {
      const { ok, value } = parseJson(payload);
      if (!ok || value === null || typeof value.id !== 'number') return { kind: 'cert', id: -1, clean: false };
      return { kind: 'cert', id: value.id, host: value.host, port: value.port, hop: value.hop, mismatch: value.mismatch === true, clean: true };
    }
    case MSG.DISCONNECTED: {
      const { ok, value } = parseJson(payload);
      const clean = ok && value !== null && (value.error === null || typeof value.error === 'string');
      return { kind: 'disconnected', error: clean ? value.error : payload.toString('utf8'), clean };
    }
    default:
      return { kind: 'other', type };
  }
}

function describeError(e) {
  if (e.kind === 'error') {
    const base = e.code !== undefined ? `${e.message} (code ${e.code})` : e.message;
    return e.tls ? `${base} tls: ${e.tls}` : base;
  }
  return `disconnected: ${e.error}`;
}

/** Extra rules for an expected failure: tls must match a regex, or the code must not be notCode. */
function checkFailure(failure, rules) {
  if (rules.tls && !(failure.tls && rules.tls.test(failure.tls))) {
    return `expected an OpenSSL reason matching ${rules.tls}`;
  }
  if (rules.notCode !== undefined && failure.code === rules.notCode) {
    return `failed with code ${rules.notCode}, which this case must get past`;
  }
  return null;
}

export function evaluateCase(expect, events, rules = {}) {
  const connected = events.find((e) => e.kind === 'connected');
  const frames = events.filter((e) => e.kind === 'bitmap').length;
  const failures = events.filter(
    (e) => e.kind === 'error' || (e.kind === 'disconnected' && e.error !== null),
  );

  if (expect === 'connect') {
    if (failures.length) return { pass: false, detail: describeError(failures[0]) };
    if (!connected) return { pass: false, detail: 'never connected' };
    if (!frames) return { pass: false, detail: `connected ${connected.width}x${connected.height} but no frames` };
    return { pass: true, detail: `connected ${connected.width}x${connected.height}, ${frames} frames` };
  }

  if (connected) return { pass: false, detail: 'connected but should have failed' };
  if (!failures.length) return { pass: false, detail: 'no error reported' };
  const unclean = failures.find((e) => !e.clean);
  if (unclean) return { pass: false, detail: `error was not clean JSON: ${String(describeError(unclean)).slice(0, 120)}` };
  const problem = checkFailure(failures[0], rules);
  if (problem) return { pass: false, detail: `${problem}; got ${describeError(failures[0])}` };
  return { pass: true, detail: describeError(failures[0]) };
}
