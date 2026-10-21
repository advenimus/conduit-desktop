#!/usr/bin/env node
// Drives the Conduit FreeRDP helper through the local RD Gateway rig.
// Run ./up.sh first. Override the helper with HELPER_BIN=/path/to/conduit-freerdp.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_OPENSSL_CONF,
  TLS_CONNECT_FAILED,
  buildConnectCommand,
  createFrameParser,
  decodeMessage,
  evaluateCase,
} from './lib/helper-protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LOG_DIR = join(HERE, 'logs');

const GW_PORT = Number(process.env.GW_PORT || 18443);
const DOWN_PORT = Number(process.env.DOWN_PORT || 18499);
const CASE_TIMEOUT_MS = Number(process.env.CASE_TIMEOUT_MS || 30000);
const ENABLE_NLA = process.env.ENABLE_NLA !== '0';
const LEGACY = process.env.LEGACY === '1';
const LEGACY_TLS10_PORT = Number(process.env.LEGACY_TLS10_PORT || 18444);
const LEGACY_WEAK_PORT = Number(process.env.LEGACY_WEAK_PORT || 18445);
const LEGACY_RENEG_PORT = Number(process.env.LEGACY_RENEG_PORT || 18446);
const LEGACY_CONF = join(LOG_DIR, 'openssl-legacy.cnf');

const GW_USER = 'gwuser';
const GW_PASS = 'GwTest-Pass1!';
const DESK_USER = 'deskuser';
const DESK_PASS = 'DeskTest-Pass1!';

function findHelper() {
  if (process.env.HELPER_BIN) return process.env.HELPER_BIN;
  const name = process.platform === 'win32' ? 'conduit-freerdp.exe' : 'conduit-freerdp';
  const platformDir = process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin';
  const candidates = [
    join(REPO, 'freerdp-helper', 'bundle', platformDir, name),
    join(REPO, 'freerdp-helper', 'build', name),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

const gateway = (overrides = {}) => ({
  host: '127.0.0.1',
  port: GW_PORT,
  username: GW_USER,
  password: GW_PASS,
  domain: '',
  transport: 'auto',
  bypassLocal: false,
  ...overrides,
});

const desktop = (overrides = {}) => ({
  host: 'desktop',
  port: 3389,
  username: DESK_USER,
  password: DESK_PASS,
  enableNla: ENABLE_NLA,
  ...overrides,
});

const CASES = [
  { name: 'gateway-good', label: 'good login, frames arrive', expect: 'connect', cmd: { ...desktop(), gateway: gateway() } },
  { name: 'gateway-http', label: 'transport http', expect: 'connect', cmd: { ...desktop(), gateway: gateway({ transport: 'http' }) } },
  { name: 'gateway-wrong-password', label: 'wrong gateway password', expect: 'error', cmd: { ...desktop(), gateway: gateway({ password: 'wrong "pass" \\ word' }) } },
  { name: 'gateway-down', label: 'gateway down', expect: 'error', cmd: { ...desktop(), gateway: gateway({ port: DOWN_PORT }) } },
  { name: 'gateway-target-denied', label: 'target not allowed', expect: 'error', cmd: { ...desktop({ host: 'not-allowed-host' }), gateway: gateway() } },
  { name: 'gateway-rpc-unsupported', label: 'transport rpc (rdpgw has none)', expect: 'error', cmd: { ...desktop(), gateway: gateway({ transport: 'rpc' }) } },
  { name: 'cert-trusted', label: 'certificate asked, trusted', expect: 'connect', certAnswer: true, cmd: { ...desktop({ skipCertVerification: false }), gateway: gateway() } },
  { name: 'cert-refused', label: 'certificate asked, refused', expect: 'error', certAnswer: false, cmd: { ...desktop({ skipCertVerification: false }), gateway: gateway() } },
];

// Old-server fronts from legacy-up.sh; run with LEGACY=1.
const LEGACY_CASES = [
  { name: 'legacy-tls10-off', label: 'TLS 1.0 gateway, switch off', expect: 'error', rules: { tls: /protocol version|unsupported protocol/ }, cmd: { ...desktop(), gateway: gateway({ port: LEGACY_TLS10_PORT }) } },
  { name: 'legacy-tls10-on', label: 'TLS 1.0 gateway, switch on', expect: 'connect', cmd: { ...desktop(), gateway: gateway({ port: LEGACY_TLS10_PORT, legacyTls: true }) } },
  { name: 'legacy-tls10-target-only', label: 'TLS 1.0 gateway, entry switch only', expect: 'error', rules: { tls: /protocol version|unsupported protocol/ }, cmd: { ...desktop({ legacyTls: true }), gateway: gateway({ port: LEGACY_TLS10_PORT }) } },
  { name: 'legacy-weak-cert', label: 'SHA-1/1024-bit gateway cert', expect: 'connect', cmd: { ...desktop(), gateway: gateway({ port: LEGACY_WEAK_PORT }) } },
  { name: 'legacy-reneg-off', label: 'no secure renegotiation, off', expect: 'error', cmd: { ...desktop(), gateway: gateway({ port: LEGACY_RENEG_PORT }) } },
  { name: 'legacy-reneg-on', label: 'no secure renegotiation, on', expect: 'error', rules: { notCode: TLS_CONNECT_FAILED }, env: { OPENSSL_CONF: LEGACY_CONF }, cmd: { ...desktop(), gateway: gateway({ port: LEGACY_RENEG_PORT, legacyTls: true }) } },
];

function runCase(helper, c) {
  return new Promise((done) => {
    const events = [];
    let stderr = '';
    let settleTimer = null;
    let finished = false;

    const child = spawn(helper, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENSSL_MODULES: join(dirname(helper), 'ossl-modules'), ...(c.env ?? {}) },
    });

    const finish = (note) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(settleTimer);
      try {
        child.stdin.write(JSON.stringify({ type: 'disconnect' }) + '\n');
        child.stdin.end();
      } catch {
        // The helper may already be gone.
      }
      const killer = setTimeout(() => child.kill('SIGKILL'), 3000);
      const report = () => {
        clearTimeout(killer);
        writeFileSync(join(LOG_DIR, `${c.name}.helper.log`), stderr);
        const result = evaluateCase(c.expect, events, c.rules);
        const asked = events.filter((e) => e.kind === 'cert');
        if (c.certAnswer !== undefined && !asked.length) {
          result.pass = false;
          result.detail = `no certificate question; ${result.detail}`;
        } else if (c.certAnswer === undefined && asked.length) {
          result.pass = false;
          result.detail = `unexpected certificate question; ${result.detail}`;
        } else if (asked.length) {
          result.detail = `${result.detail}; asked about ${asked.map((e) => `${e.host}:${e.port} (${e.hop})`).join(', ')}`;
        }
        const leaked = [GW_PASS, DESK_PASS, c.cmd.gateway?.password].filter(
          (s) => s && stderr.includes(s),
        );
        if (leaked.length) {
          result.pass = false;
          result.detail = `password printed to stderr; ${result.detail}`;
        }
        if (note && !result.pass) result.detail = `${note}; ${result.detail}`;
        done(result);
      };
      if (child.exitCode !== null || child.signalCode !== null) report();
      else child.once('close', report);
    };

    const parser = createFrameParser((type, payload) => {
      const msg = decodeMessage(type, payload);
      events.push(msg);
      if (msg.kind === 'cert') {
        // The helper waits for an answer; a case that expects no question refuses it and fails in the report.
        child.stdin.write(JSON.stringify({ type: 'cert_response', id: msg.id, accept: c.certAnswer === true }) + '\n');
        return;
      }
      const frames = events.filter((e) => e.kind === 'bitmap').length;
      const failed = msg.kind === 'error' || (msg.kind === 'disconnected' && msg.error !== null);
      if ((c.expect === 'connect' && frames >= 1 && events.some((e) => e.kind === 'connected')) || failed) {
        settleTimer ??= setTimeout(() => finish(), 750);
      }
    });

    const timeout = setTimeout(() => finish(`timed out after ${CASE_TIMEOUT_MS / 1000}s`), CASE_TIMEOUT_MS);
    child.stdout.on('data', (d) => parser.feed(d));
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      events.push({ kind: 'error', message: `spawn failed: ${err.message}`, clean: false });
      finish();
    });
    child.on('close', () => finish('helper exited'));

    child.stdin.write(buildConnectCommand(c.cmd));
  });
}

async function main() {
  const helper = findHelper();
  if (!existsSync(helper)) {
    console.error(`Helper not found at ${helper}. Build it (scripts/build-macos.sh) or set HELPER_BIN.`);
    process.exit(2);
  }
  mkdirSync(LOG_DIR, { recursive: true });
  console.log(`Helper: ${helper}`);
  console.log(`Gateway: 127.0.0.1:${GW_PORT}  target: desktop:3389  NLA: ${ENABLE_NLA ? 'on' : 'off'}\n`);

  const only = process.env.CASES ? new Set(process.env.CASES.split(',')) : null;
  if (LEGACY) writeFileSync(LEGACY_CONF, LEGACY_OPENSSL_CONF);
  const rows = [];
  for (const c of LEGACY ? [...CASES, ...LEGACY_CASES] : CASES) {
    if (only && !only.has(c.name)) continue;
    const r = await runCase(helper, c);
    rows.push({ result: r.pass ? 'PASS' : 'FAIL', case: c.label, detail: r.detail });
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${c.label}`);
  }

  console.log('\nRESULT CASE                             DETAIL');
  for (const r of rows) console.log(`${r.result.padEnd(6)} ${r.case.padEnd(33)} ${r.detail}`);
  console.log(`\nHelper logs: ${LOG_DIR}`);
  process.exit(rows.every((r) => r.result === 'PASS') ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
