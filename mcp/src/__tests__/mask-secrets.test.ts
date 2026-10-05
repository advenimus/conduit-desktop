// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { maskSecrets, redactSecrets, restoreSecrets } from '../mask-secrets.js';

const RAW = 'Admin: !!hunter2!!\nDB: !!s3cret pass!!\nPlain text';

describe('redactSecrets', () => {
  it('numbers each secret in order of appearance', () => {
    const redacted = redactSecrets(RAW);
    expect(redacted.text).toBe('Admin: [SECRET_1]\nDB: [SECRET_2]\nPlain text');
    expect(redacted.secrets).toEqual(['!!hunter2!!', '!!s3cret pass!!']);
  });

  it('never puts a secret value in the text', () => {
    expect(maskSecrets(RAW)).not.toMatch(/hunter2|s3cret/);
  });

  it('leaves text without secrets alone', () => {
    expect(maskSecrets('no secrets here')).toBe('no secrets here');
  });
});

describe('restoreSecrets', () => {
  const redacted = redactSecrets(RAW);

  it('puts each token back as the original secret', () => {
    const out = restoreSecrets('DB: [SECRET_2]\nAdmin: [SECRET_1]\nNew line', redacted);
    expect(out.text).toBe('DB: !!s3cret pass!!\nAdmin: !!hunter2!!\nNew line');
    expect(out.secretsRemoved).toBe(0);
  });

  it('counts secrets the new text drops', () => {
    expect(restoreSecrets('Admin: [SECRET_1]', redacted).secretsRemoved).toBe(1);
  });

  it('keeps new secrets the agent writes itself', () => {
    expect(restoreSecrets('[SECRET_1] [SECRET_2] !!newpw!!', redacted).text).toBe('!!hunter2!! !!s3cret pass!! !!newpw!!');
  });

  it('rejects a token that is not in the current notes', () => {
    expect(() => restoreSecrets('[SECRET_3]', redacted)).toThrow(/SECRET_3/);
  });

  it('rejects the old bare [REDACTED] marker, which would erase a secret', () => {
    expect(() => restoreSecrets('Admin: [REDACTED]', redacted)).toThrow(/\[REDACTED\]/);
  });

  it('allows [REDACTED] when the notes already had it as plain text', () => {
    const own = redactSecrets('Status: [REDACTED] by legal, pw !!x!!');
    expect(restoreSecrets('Status: [REDACTED] by legal, pw [SECRET_1]', own).text).toBe('Status: [REDACTED] by legal, pw !!x!!');
  });

  it('rejects a token placed where it would break out of its !! markers', () => {
    expect(() => restoreSecrets('!!prefix [SECRET_1]!!', redacted)).toThrow(/stand on its own/);
    expect(() => restoreSecrets('!![SECRET_1]', redacted)).toThrow(/stand on its own/);
  });

  it('refuses notes whose plain text already looks like a token', () => {
    const odd = redactSecrets('See [SECRET_1] in the docs, pw !!x!!');
    expect(() => restoreSecrets('See [SECRET_1] in the docs, pw [SECRET_1]', odd)).toThrow(/looks like a secret token/);
  });
});
