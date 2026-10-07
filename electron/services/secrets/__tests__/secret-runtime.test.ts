// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { TOTP } from 'otpauth';
import { resolveRef, substituteRefs, SecretRefError, type ResolverVault } from '../secret-resolver.js';
import { SecretScrubber, type ScrubVault } from '../secret-scrubber.js';
import { generateSecret } from '../secret-generate.js';
import { parseRefs } from '../secret-refs.js';

const S1 = '11111111-2222-4333-8444-555555555555';
const S1P = '11111111-2222-4333-8444-555555555556';
const C1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

const creds: Record<string, { name: string; username: string | null; password: string | null; totp_secret: string | null; entry_type: string; config: unknown }> = {
  [S1]: { name: 'Local admin', username: null, password: 'hunter2-long', totp_secret: null, entry_type: 'credential', config: { embedded: { owner_id: 'x', label: 'Local admin' } } },
  [S1P]: { name: 'Local admin (new)', username: null, password: 'next-value-99', totp_secret: null, entry_type: 'credential', config: { embedded: { owner_id: 'x', label: 'Local admin', pending_for: S1 } } },
  [C1]: { name: 'Domain admin', username: 'CORP\\admin', password: 'Sup3r-Secret!', totp_secret: TOTP_SECRET, entry_type: 'credential', config: {} },
  web: { name: 'web-01', username: 'root', password: 'inline-pass-1', totp_secret: null, entry_type: 'ssh', config: {} },
  short: { name: 'tiny', username: null, password: 'abc', totp_secret: null, entry_type: 'credential', config: {} },
};

const vault: ResolverVault & ScrubVault = {
  isUnlocked: () => true,
  getCredential: (id) => {
    const c = creds[id];
    if (!c) throw new Error('not found');
    return { id, name: c.name, username: c.username, password: c.password, totp_secret: c.totp_secret, totp_algorithm: null, totp_digits: null, totp_period: null };
  },
  getEntry: (id) => ({ password: creds[id].password, private_key: null }),
  listEntries: () => Object.entries(creds).map(([id, c]) => ({ id, name: c.name, entry_type: c.entry_type, config: c.config, updated_at: '2026-10-01T00:00:00.000Z' })),
};

describe('substituteRefs', () => {
  it('swaps secret and cred refs for values and reports what it used', () => {
    const out = substituteRefs(vault, `sudo -S true <<< {{secret:${S1}|Local admin}}; login {{cred:${C1}.username}} {{cred:${C1}}}`);
    expect(out.text).toBe('sudo -S true <<< hunter2-long; login CORP\\admin Sup3r-Secret!');
    expect(out.used.map((u) => u.label)).toEqual(['Local admin', 'Domain admin', 'Domain admin']);
  });

  it('resolves a pending ref to the staged rotation value', () => {
    expect(substituteRefs(vault, `{{secret:${S1}.pending}}`).text).toBe('next-value-99');
  });

  it('types the current one-time code for .totp', () => {
    const [ref] = parseRefs(`{{cred:${C1}.totp}}`);
    const expected = new TOTP({ secret: TOTP_SECRET }).generate();
    expect(resolveRef(vault, ref).value).toBe(expected);
  });

  it('leaves text without refs alone', () => {
    expect(substituteRefs(vault, 'echo hi')).toEqual({ text: 'echo hi', used: [] });
  });

  it('refuses unknown ids and empty fields', () => {
    expect(() => substituteRefs(vault, '{{secret:99999999-2222-4333-8444-555555555555}}')).toThrow(SecretRefError);
    expect(() => substituteRefs(vault, `{{cred:${S1}.username}}`)).toThrow(/no username/);
    expect(() => substituteRefs(vault, `{{secret:${C1}.pending}}`)).toThrow(/no staged rotation/);
  });
});

describe('SecretScrubber', () => {
  it('replaces vault secrets in agent-bound text', () => {
    const scrubber = new SecretScrubber();
    const text = 'PASSWORD=hunter2-long\nroot:inline-pass-1\ncorp Sup3r-Secret! abc';
    expect(scrubber.scrub(vault, text)).toBe(
      `PASSWORD={{secret:${S1}|Local admin}}\nroot:[password: web-01]\ncorp [credential: Domain admin] abc`,
    );
  });

  it('scrubs strings inside objects and arrays', () => {
    const scrubber = new SecretScrubber();
    expect(scrubber.scrubDeep(vault, { output: 'x hunter2-long', list: ['inline-pass-1'], n: 3 })).toEqual({
      output: `x {{secret:${S1}|Local admin}}`,
      list: ['[password: web-01]'],
      n: 3,
    });
  });

  it('prefers the longest match', () => {
    const scrubber = new SecretScrubber();
    const extra = [{ value: 'hunter2', replacement: '[short]' }];
    expect(scrubber.scrub(vault, 'hunter2-long and hunter2', extra)).toBe(`{{secret:${S1}|Local admin}} and [short]`);
  });

  it('does nothing while the vault is locked', () => {
    const scrubber = new SecretScrubber();
    expect(scrubber.scrub({ ...vault, isUnlocked: () => false }, 'hunter2-long')).toBe('hunter2-long');
  });
});

describe('generateSecret', () => {
  it('makes values of the asked length from shell-safe characters', () => {
    for (let i = 0; i < 50; i++) {
      const v = generateSecret({ length: 20 });
      expect(v).toHaveLength(20);
      expect(v).toMatch(/^[A-Za-z0-9\-_.@%+=:,]+$/);
      expect(v).toMatch(/[0-9]/);
    }
    expect(generateSecret({ symbols: false })).toMatch(/^[A-Za-z0-9]{24}$/);
  });

  it('rejects lengths out of range', () => {
    expect(() => generateSecret({ length: 4 })).toThrow();
    expect(() => generateSecret({ length: 500 })).toThrow();
  });
});
