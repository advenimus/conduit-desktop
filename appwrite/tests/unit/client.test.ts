import { describe, expect, it } from 'vitest';
import { ConduitDb } from '../../src/client/index.ts';

const answering = (status: number, body: string) => new ConduitDb(async () => ({ status, body }));

describe('client error handling', () => {
  it('an empty 500 is an error, never a success', async () => {
    const r = await answering(500, '').from('tiers').select('*');
    expect(r.error).toMatchObject({ code: 'XX000' });
    const up = await answering(500, '').storage.from('vaults').upload('u/manifest.json', '{}');
    expect(up.error).not.toBeNull();
  });

  it('keeps the api error and passes data through on 200', async () => {
    expect((await answering(403, JSON.stringify({ data: null, error: { code: '42501', message: 'no', details: null, hint: null } })).rpc('x')).error?.code).toBe('42501');
    expect((await answering(200, JSON.stringify({ data: [1], error: null, count: 1 })).from('t').select('*')).data).toEqual([1]);
  });

  it('a transport that throws is a network error with status 0', async () => {
    const r = await new ConduitDb(async () => {
      throw new Error('ECONNREFUSED');
    }).rpc('x');
    expect(r).toMatchObject({ status: 0, error: { code: 'NETWORK' } });
  });
});
