// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execRegexWithTimeout, RegexTimeoutError } from '../safe-regex.js';

describe('execRegexWithTimeout', () => {
  it('returns the match and groups', async () => {
    expect(await execRegexWithTimeout('^key: (\\S+)$', 'm', 'x\nkey: abc123\ny')).toEqual(['key: abc123', 'abc123']);
    expect(await execRegexWithTimeout('nope', 'm', 'text')).toBeNull();
  });

  it('stops a catastrophic pattern instead of freezing', async () => {
    const started = Date.now();
    await expect(execRegexWithTimeout('(a+)+$', '', `${'a'.repeat(40)}!`, 300)).rejects.toBeInstanceOf(RegexTimeoutError);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
