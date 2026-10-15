import { describe, expect, it } from 'vitest';
import { World } from './harness.ts';

const hit = (key: string, limit = 3, window = 60) => ({ kind: 'rpc' as const, fn: 'rate_limit_hit', args: { p_key: key, p_limit: limit, p_window_seconds: window } });

describe('rate_limit_hit', () => {
  it('allows `limit` hits per window, then refuses until the window ends', async () => {
    const w = await World.create();
    const answers = [];
    for (let i = 0; i < 4; i++) answers.push(await w.ok('service', hit('login:email:a@b.c')));
    expect(answers.map((a) => (a as { allowed: boolean }).allowed)).toEqual([true, true, true, false]);
    expect(answers[3]).toMatchObject({ remaining: 0, retry_after: 60 });
    expect(await w.ok('service', hit('login:email:other@b.c'))).toMatchObject({ allowed: true, remaining: 2 });
    w.clock += 61_000;
    expect(await w.ok('service', hit('login:email:a@b.c'))).toMatchObject({ allowed: true, remaining: 2 });
    const rows = await w.rows('rate_limits');
    expect(rows.every((r) => !String(r.key).includes('@'))).toBe(true);
  });

  it('is service only and checks its arguments', async () => {
    const w = await World.create();
    await w.mkUser('rl');
    expect(await w.err('rl', hit('x'))).toMatch(/^42501/);
    expect(await w.err('service', hit('x', 0))).toMatch(/^22023/);
    expect(await w.err('service', { kind: 'rpc', fn: 'rate_limit_hit', args: { p_key: '', p_limit: 1, p_window_seconds: 1 } })).toMatch(/^22023/);
  });
});
