// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeCertificate } from '../cert-details.js';
import { CertPromptManager, type CertPromptInfo, type CertPromptOutcome } from '../cert-prompts.js';
import { RdpCertTrust, type HelperCertRequest } from '../cert-trust.js';
import { CertTrustStore, hostKey, parseTrustFile } from '../trust-store.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const pem = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const CERT_A = pem('rdg-a.pem');
const CERT_B = pem('rdg-b.pem');
const EXPIRED = pem('expired.pem');
const FP_A = 'C2:6A:53:AB:64:44:C4:C9:12:9A:27:AC:E0:ED:79:0B:44:46:D9:63:69:D0:6F:49:76:A0:BE:E0:4C:B0:44:EB';
const NOW = new Date('2026-10-21T12:00:00Z');

describe('describeCertificate', () => {
  it('reads names, dates and the SHA-256 fingerprint', () => {
    const d = describeCertificate(CERT_A, 'rdg.example.com', NOW)!;
    expect(d.fingerprint).toBe(FP_A);
    expect(d.subject).toBe('CN=rdg.example.com, O=Example Corp');
    expect(d.issuer).toBe('CN=rdg.example.com, O=Example Corp');
    expect(d.validFrom).toBe('2026-01-01T00:00:00.000Z');
    expect(d.validTo).toBe('2036-01-01T00:00:00.000Z');
    expect(d).toMatchObject({ expired: false, notYetValid: false, nameMatches: true, selfSigned: true });
  });

  it('matches IP addresses and rejects other names', () => {
    expect(describeCertificate(CERT_A, '10.0.0.5', NOW)!.nameMatches).toBe(true);
    expect(describeCertificate(CERT_A, 'RDG.Example.com', NOW)!.nameMatches).toBe(true);
    expect(describeCertificate(CERT_A, 'other.example.com', NOW)!.nameMatches).toBe(false);
    expect(describeCertificate(CERT_A, '10.0.0.6', NOW)!.nameMatches).toBe(false);
  });

  it('flags expired and not-yet-valid certificates', () => {
    expect(describeCertificate(EXPIRED, 'old.example.com', NOW)!.expired).toBe(true);
    expect(describeCertificate(CERT_A, 'rdg.example.com', new Date('2025-06-01'))!.notYetValid).toBe(true);
  });

  it('returns null for something that is not a certificate', () => {
    expect(describeCertificate('not a pem', 'x', NOW)).toBeNull();
    expect(describeCertificate('', 'x', NOW)).toBeNull();
  });
});

describe('CertTrustStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-trust-'));
    file = path.join(dir, 'sub', 'trusted.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const entry = { fingerprint: FP_A, subject: 'CN=a', issuer: 'CN=a', validTo: '2036-01-01T00:00:00.000Z', trustedAt: NOW.toISOString() };

  it('keys by host and port, ignoring case and IPv6 brackets', () => {
    expect(hostKey('RDG.Example.com', 443)).toBe('rdg.example.com:443');
    expect(hostKey('[2001:DB8::1]', 8443)).toBe('[2001:db8::1]:8443');
    expect(hostKey('2001:db8::1', 8443)).toBe('[2001:db8::1]:8443');
  });

  it('remembers per host and port, in a file only this user can read', () => {
    const store = new CertTrustStore(() => file);
    expect(store.get('rdg.example.com', 443)).toBeNull();
    store.remember('RDG.example.com', 443, entry);
    expect(store.get('rdg.example.com', 443)).toEqual(entry);
    expect(store.get('rdg.example.com', 8443)).toBeNull();
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('treats a broken file as empty and replaces it on the next save', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const store = new CertTrustStore(() => file);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(store.get('rdg.example.com', 443)).toBeNull();
    store.remember('rdg.example.com', 443, entry);
    expect(store.get('rdg.example.com', 443)).toEqual(entry);
  });

  it('drops entries that are not valid', () => {
    const hosts = { 'a:1': entry, 'b:2': { ...entry, fingerprint: 'nope' }, 'c:3': 'x' };
    expect(Object.keys(parseTrustFile(JSON.stringify({ version: 1, hosts })))).toEqual(['a:1']);
    expect(parseTrustFile('[]')).toEqual({});
    expect(parseTrustFile('null')).toEqual({});
  });
});

describe('RdpCertTrust', () => {
  let dir: string;
  let store: CertTrustStore;
  let asked: Omit<CertPromptInfo, 'request_id'>[];
  let answer: CertPromptOutcome;
  const prompts = {
    request: vi.fn(async (info: Omit<CertPromptInfo, 'request_id'>) => {
      asked.push(info);
      return answer;
    }),
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-trust-'));
    store = new CertTrustStore(() => path.join(dir, 'trusted.json'));
    asked = [];
    answer = 'cancel';
    prompts.request.mockClear();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const trust = () => new RdpCertTrust(store, prompts, () => NOW);
  const req = (over: Partial<HelperCertRequest> = {}): HelperCertRequest => ({
    id: 1, host: 'rdg.example.com', port: 443, hop: 'gateway', mismatch: false, changed: false, pem: CERT_A, ...over,
  });
  const user = { origin: 'user' as const, connectionName: 'Office PC' };

  it('asks about a new certificate and shows what the user needs to decide', async () => {
    const verdict = await trust().check(req(), user);
    expect(verdict).toEqual({ accept: false, message: 'You did not trust the certificate of the gateway rdg.example.com:443.' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      origin: 'user', kind: 'new', hop: 'gateway', host: 'rdg.example.com', port: 443, connection_name: 'Office PC',
      problems: ['untrusted'], fingerprint: FP_A, valid_to: '2036-01-01T00:00:00.000Z', previous: null,
    });
  });

  it('trusts once without remembering', async () => {
    answer = 'once';
    expect(await trust().check(req(), user)).toEqual({ accept: true });
    expect(store.get('rdg.example.com', 443)).toBeNull();
  });

  it('remembers Always trust and then connects without asking', async () => {
    answer = 'always';
    expect(await trust().check(req(), user)).toEqual({ accept: true });
    expect(store.get('rdg.example.com', 443)?.fingerprint).toBe(FP_A);

    expect(await trust().check(req(), user)).toEqual({ accept: true });
    expect(asked).toHaveLength(1);
  });

  it('warns when a remembered certificate changed, and replaces it on Always trust', async () => {
    answer = 'always';
    await trust().check(req(), user);
    answer = 'cancel';
    expect((await trust().check(req({ pem: CERT_B }), user)).accept).toBe(false);
    expect(asked[1]).toMatchObject({ kind: 'changed', previous: { fingerprint: FP_A } });
    expect(store.get('rdg.example.com', 443)?.fingerprint).toBe(FP_A);

    answer = 'always';
    expect(await trust().check(req({ pem: CERT_B }), user)).toEqual({ accept: true });
    expect(store.get('rdg.example.com', 443)?.fingerprint).not.toBe(FP_A);
  });

  it('remembers per port: the same host on another port asks again', async () => {
    answer = 'always';
    await trust().check(req(), user);
    answer = 'cancel';
    await trust().check(req({ port: 3389, hop: 'target' }), user);
    expect(asked).toHaveLength(2);
    expect(asked[1].kind).toBe('new');
  });

  it('lists the problems: wrong name, untrusted, expiry', async () => {
    await trust().check(req({ host: 'other.example.com', mismatch: true }), user);
    await trust().check(req({ host: '10.0.0.5', mismatch: true }), user);
    await trust().check(req({ host: 'old.example.com', pem: EXPIRED }), user);
    expect(asked.map((a) => a.problems)).toEqual([['name', 'untrusted'], ['untrusted'], ['untrusted', 'expired']]);
  });

  it('says only "not fully verified" for a self-signed root this computer trusts, reached by IP', async () => {
    const rootTrust = new RdpCertTrust(store, prompts, () => NOW, (fp) => fp === FP_A);
    await rootTrust.check(req({ host: '10.0.0.5', mismatch: true }), user);
    expect(asked[0].problems).toEqual(['unverified']);
  });

  it('names the fix when no one answers for an agent', async () => {
    answer = 'timeout';
    const verdict = await trust().check(req({ hop: 'target', host: 'pc1', port: 3389 }), { origin: 'agent' });
    expect(verdict.accept).toBe(false);
    expect(!verdict.accept && verdict.message).toContain('choose Always trust');
    expect(!verdict.accept && verdict.message).toContain('Skip certificate verification');

    answer = 'no-window';
    const noWindow = await trust().check(req(), { origin: 'agent' });
    expect(!noWindow.accept && noWindow.message).toContain('no one answered in the Conduit app');
  });

  it('refuses an unreadable certificate without asking', async () => {
    const verdict = await trust().check(req({ pem: 'garbage' }), user);
    expect(verdict.accept).toBe(false);
    expect(asked).toHaveLength(0);
  });

  it('still connects once when Always trust cannot be saved', async () => {
    answer = 'always';
    const broken = { get: () => null, remember: () => { throw new Error('disk full'); } };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await new RdpCertTrust(broken, prompts, () => NOW).check(req(), user)).toEqual({ accept: true });
  });
});

describe('CertPromptManager', () => {
  const info = {
    origin: 'user' as const, kind: 'new' as const, hop: 'target' as const, host: 'pc1', port: 3389, connection_name: null,
    problems: [], subject: '', issuer: '', valid_from: '', valid_to: '', fingerprint: FP_A, previous: null,
  };

  it('answers no-window when there is no window', async () => {
    const m = new CertPromptManager();
    expect(await m.request(info)).toBe('no-window');
    m.setNotifier({ requested: () => false, resolved: () => {} });
    expect(await m.request(info)).toBe('no-window');
    expect(m.listPending()).toEqual([]);
  });

  it('passes the user answer through and closes the dialog', async () => {
    const resolved: [string, CertPromptOutcome][] = [];
    const m = new CertPromptManager();
    m.setNotifier({ requested: () => true, resolved: (id, o) => resolved.push([id, o]) });
    const pending = m.request(info);
    const [shown] = m.listPending();
    expect(m.answer(shown.request_id, 'always')).toBe(true);
    expect(await pending).toBe('always');
    expect(m.answer(shown.request_id, 'once')).toBe(false);
    expect(resolved).toEqual([[shown.request_id, 'always']]);
  });

  it('times out to timeout', async () => {
    vi.useFakeTimers();
    try {
      const m = new CertPromptManager();
      m.setNotifier({ requested: () => true, resolved: () => {} });
      const pending = m.request(info, { timeoutMs: 1000 });
      vi.advanceTimersByTime(1000);
      expect(await pending).toBe('timeout');
      expect(m.listPending()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the question when the connection closes', async () => {
    const m = new CertPromptManager();
    m.setNotifier({ requested: () => true, resolved: () => {} });
    const ctrl = new AbortController();
    const pending = m.request(info, { signal: ctrl.signal });
    ctrl.abort();
    expect(await pending).toBe('aborted');
    expect(await m.request(info, { signal: ctrl.signal })).toBe('aborted');
  });
});
