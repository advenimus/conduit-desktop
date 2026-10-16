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
  ERROR: 0xff,
});

export function buildConnectCommand({
  host,
  port,
  username,
  password,
  domain = '',
  width = 1024,
  height = 768,
  enableNla = true,
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
    skipCertVerification: true,
    enableGfx: true,
    enableH264: true,
    drives: [],
    desktopScaleFactor: 100,
    deviceScaleFactor: 100,
    enableClipboard: true,
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
      return msg;
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
  if (e.kind === 'error') return e.code !== undefined ? `${e.message} (code ${e.code})` : e.message;
  return `disconnected: ${e.error}`;
}

export function evaluateCase(expect, events) {
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
  return { pass: true, detail: describeError(failures[0]) };
}
