/**
 * macOS Local Network permission handling.
 *
 * macOS 15+ gates access to LAN addresses behind a TCC permission. The system
 * only evaluates it when a process actually touches the local network, and it
 * only ever shows the consent alert once per app identity — after that it
 * silently denies. A packaged Conduit build that never touches the LAN until
 * the user opens a connection therefore looks broken: the connection fails and
 * no alert was ever offered.
 *
 * Triggering and detecting need two different operations, because macOS gives
 * no API for either (Apple TN3179, FB8711182):
 *
 *   - Trigger: connect a UDP socket to each link-local IPv6 address. Apple's
 *     documented way to raise the alert on demand. It sends no traffic and
 *     always reports success, so it can only ask — never answer.
 *   - Detect: send a Bonjour query to the mDNS multicast group. macOS blocks
 *     that send when the permission is missing, which gives the answer.
 *
 * Apple's older broadcast-to-port-9 sample is explicitly retired; do not
 * reintroduce it as a trigger.
 *
 * Detection signature verified on macOS 27.0: a process without the permission
 * gets EHOSTUNREACH from `sendto()` to 224.0.0.251 and from TCP connects to LAN
 * addresses, while WAN connects succeed and the LAN gateway's ARP entry
 * resolves normally.
 *
 * Note that macOS cannot reset this permission back to "undetermined", so an
 * app that has already been recorded as denied will never see the alert again
 * no matter how often it is triggered. That is why a denial has to end in
 * on-screen guidance rather than another retry.
 */

import dgram from 'node:dgram';
import os from 'node:os';
import { isIPv4 } from 'node:net';

/** mDNS link-local multicast group — reachable without routing or ARP. */
const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;

/** Give up on a single probe rather than letting startup hang on a wedged socket. */
const PROBE_TIMEOUT_MS = 3_000;

/** RFC 863 discard — nothing is ever sent, the port only completes the peer address. */
const DISCARD_PORT = 9;

/** How long to keep re-probing while the user decides on the consent alert. */
const SETTLE_WINDOW_MS = 60_000;
const SETTLE_INTERVAL_MS = 3_000;

/**
 * Marker appended to connection errors that macOS caused. The renderer's
 * error table matches on it, so the technical errno never reaches the user.
 */
export const LOCAL_NETWORK_BLOCKED_TAG = 'ConduitLocalNetworkBlocked';

export function localNetworkAppName(isPackaged: boolean): string {
  return isPackaged ? 'Conduit' : 'Conduit Dev';
}

export type LocalNetworkStatus =
  /** Local network traffic left the machine. */
  | 'granted'
  /** macOS refused the send — the permission is missing or was declined. */
  | 'denied'
  /** Nothing to probe (not macOS, or no real network interface). */
  | 'unavailable';

/**
 * Point-to-point tunnels (utun, VPNs) carry a /32 address — no subnet, and no
 * link-local multicast. A machine holding only tunnels would fail the probe for
 * reasons that have nothing to do with the permission, so it reports
 * 'unavailable' instead.
 *
 * Netmask rather than MAC: macOS masks hardware addresses for privacy, so a
 * real Wi-Fi interface can report a placeholder MAC and would be misread as a
 * tunnel — which would silently switch this whole module off.
 */
const POINT_TO_POINT_NETMASK = '255.255.255.255';

function hasRealNetworkInterface(): boolean {
  return Object.values(os.networkInterfaces()).some((addresses) =>
    (addresses ?? []).some(
      (addr) =>
        addr.family === 'IPv4' &&
        !addr.internal &&
        addr.netmask !== POINT_TO_POINT_NETMASK,
    ),
  );
}

/**
 * A standard mDNS PTR query for the service-enumeration meta-record. Sending a
 * well-formed query keeps the probe indistinguishable from ordinary Bonjour
 * discovery; macOS only cares that the datagram targets a local multicast
 * group, but responders on the network should not see malformed traffic.
 */
function buildServiceEnumerationQuery(): Buffer {
  const header = Buffer.from([
    0x00, 0x00, // transaction id
    0x00, 0x00, // flags: standard query
    0x00, 0x01, // one question
    0x00, 0x00, // no answers
    0x00, 0x00, // no authority records
    0x00, 0x00, // no additional records
  ]);
  const labels = ['_services', '_dns-sd', '_udp', 'local'].flatMap((label) => [
    Buffer.from([label.length]),
    Buffer.from(label, 'ascii'),
  ]);
  const footer = Buffer.from([
    0x00, // root label
    0x00, 0x0c, // QTYPE = PTR
    0x00, 0x01, // QCLASS = IN
  ]);
  return Buffer.concat([header, ...labels, footer]);
}

/**
 * Codes macOS returns when it blocks local network traffic. ENETDOWN and
 * ENETUNREACH are deliberately absent — those mean the machine has no network
 * at all, which is not a permission problem.
 */
const DENIAL_CODES = new Set(['EHOSTUNREACH', 'EACCES', 'EPERM']);

function classify(err: NodeJS.ErrnoException): LocalNetworkStatus {
  return DENIAL_CODES.has(err.code ?? '') ? 'denied' : 'unavailable';
}

/**
 * Send one Bonjour query to the mDNS group and report whether macOS let it out.
 * Never rejects — every failure maps onto a status.
 */
export function probeLocalNetwork(): Promise<LocalNetworkStatus> {
  if (process.platform !== 'darwin') return Promise.resolve('granted');
  if (!hasRealNetworkInterface()) return Promise.resolve('unavailable');

  return new Promise<LocalNetworkStatus>((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;

    const finish = (status: LocalNetworkStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(status);
    };

    const timer = setTimeout(() => finish('unavailable'), PROBE_TIMEOUT_MS);
    timer.unref?.();

    socket.on('error', (err: NodeJS.ErrnoException) => finish(classify(err)));

    socket.bind(0, () => {
      try {
        socket.setMulticastTTL(255);
      } catch {
        /* not fatal — the send below is what exercises the permission */
      }
      const query = buildServiceEnumerationQuery();
      socket.send(query, 0, query.length, MDNS_PORT, MDNS_GROUP, (err) => {
        finish(err ? classify(err as NodeJS.ErrnoException) : 'granted');
      });
    });
  });
}

export type TriggerTarget = { family: 'udp4' | 'udp6'; host: string };

/**
 * Addresses whose UDP `connect()` is a local-network operation (Apple TN3179).
 * IPv6 link-local is the documented trigger. IPv4 LAN addresses are included
 * too: a machine with IPv6 off would otherwise never raise the alert.
 */
export function collectTriggerTargets(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): TriggerTarget[] {
  const targets: TriggerTarget[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const addr of addresses ?? []) {
      if (addr.internal) continue;
      if (
        addr.family === 'IPv6' &&
        addr.scopeid !== 0 &&
        addr.address.toLowerCase().startsWith('fe80')
      ) {
        targets.push({ family: 'udp6', host: `${addr.address}%${name}` });
      }
      if (addr.family === 'IPv4' && addr.netmask !== POINT_TO_POINT_NETMASK) {
        targets.push({ family: 'udp4', host: addr.address });
      }
    }
  }
  return targets;
}

/**
 * Ask macOS to make a permission decision, per Apple TN3179: connect a UDP
 * socket to local network addresses. `connect()` only fixes the socket's peer
 * — no packet is sent — but it is enough for the system to evaluate local
 * network access and raise the consent alert if the app has no recorded
 * decision yet.
 *
 * Best effort by design. Apple gives no guarantee the alert appears, and the
 * call succeeds whether access is granted or denied, so this never reports a
 * status. Interface names are read from the system rather than hardcoded —
 * BSD names such as `en0` are not stable API.
 */
export function triggerLocalNetworkAlert(): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve();

  const targets = collectTriggerTargets();

  return Promise.all(
    targets.map(
      (target) =>
        new Promise<void>((resolve) => {
          const socket = dgram.createSocket(target.family);
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
              socket.close();
            } catch {
              /* already closed */
            }
            resolve();
          };

          const timer = setTimeout(finish, PROBE_TIMEOUT_MS);
          timer.unref?.();

          socket.on('error', finish);
          try {
            socket.connect(DISCARD_PORT, target.host, finish);
          } catch {
            finish();
          }
        }),
    ),
  ).then(() => undefined);
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export type LocalNetworkSettleDeps = {
  trigger?: () => Promise<void>;
  probe?: () => Promise<LocalNetworkStatus>;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
};

/**
 * Probe at startup, then keep probing while the consent alert may still be on
 * screen. Resolves 'granted' as soon as traffic gets through, or 'denied' once
 * the settle window closes with the app still blocked.
 *
 * A denied app never recovers on its own, so a 'denied' result here means
 * either the user declined or macOS is holding a stale record and will not ask
 * again. Both need the same thing from us: tell the user where the switch is.
 */
export async function ensureLocalNetworkAccess(
  settleWindowMs = SETTLE_WINDOW_MS,
  deps: LocalNetworkSettleDeps = {},
): Promise<LocalNetworkStatus> {
  const trigger = deps.trigger ?? triggerLocalNetworkAlert;
  const probe = deps.probe ?? probeLocalNetwork;
  const wait = deps.delay ?? delay;
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? SETTLE_INTERVAL_MS;

  await trigger();

  const first = await probe();
  if (first !== 'denied') return first;

  const deadline = now() + settleWindowMs;
  let latest: LocalNetworkStatus = first;

  while (now() < deadline) {
    await wait(intervalMs);
    // Re-fire the consent trigger while the user may still be looking at the
    // alert. A single shot at process start is easy to miss if the window is
    // not yet frontmost (FB16131937).
    await trigger();
    latest = await probe();
    if (latest !== 'denied') return latest;
  }

  return latest;
}

/**
 * Short-lived cache for UI callers. A granted probe puts a real Bonjour query
 * on the wire and draws replies from every responder on the network, so the
 * error screen must not re-probe on each render. The window is deliberately
 * small: the user may grant access in System Settings and come straight back,
 * and macOS applies that immediately.
 *
 * The startup settle loop and the connection-failure check deliberately call
 * `probeLocalNetwork()` instead — both need an answer for right now.
 */
const STATUS_CACHE_MS = 10_000;

let cached: { status: LocalNetworkStatus; at: number } | null = null;

export async function getLocalNetworkStatus(): Promise<LocalNetworkStatus> {
  if (cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.status;

  const status = await probeLocalNetwork();
  cached = { status, at: Date.now() };
  return status;
}

/** RFC1918, CGNAT, and link-local ranges — the addresses macOS gates. */
export function isPrivateAddress(host: string): boolean {
  if (!isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  if (a === 10) return true;
  if (a === 127) return false;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * Decide whether a failed connection to `host` was macOS blocking us rather
 * than the host being offline. Both produce EHOSTUNREACH, so the only way to
 * tell them apart is to re-check the permission at the moment of failure.
 */
export async function isLocalNetworkBlocked(host: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  if (!isPrivateAddress(host)) return false;
  return (await probeLocalNetwork()) === 'denied';
}

/**
 * Append the marker to an error message when macOS is the cause, so the
 * renderer can show guidance instead of a raw errno. Returns the message
 * unchanged in every other case.
 */
export async function annotateLocalNetworkError(
  message: string,
  host: string,
): Promise<string> {
  if (!(await isLocalNetworkBlocked(host))) return message;
  return `${message} [${LOCAL_NETWORK_BLOCKED_TAG}]`;
}

/**
 * Error-shaped form of {@link annotateLocalNetworkError}. Returns the original
 * error untouched unless macOS is the cause, in which case it returns a copy
 * carrying the marker — the original is never mutated.
 */
export async function withLocalNetworkHint(err: Error, host: string): Promise<Error> {
  const message = await annotateLocalNetworkError(err.message, host);
  if (message === err.message) return err;

  const annotated = new Error(message);
  annotated.stack = err.stack;
  const { code, level } = err as NodeJS.ErrnoException & { level?: string };
  return Object.assign(annotated, code ? { code } : {}, level ? { level } : {});
}
