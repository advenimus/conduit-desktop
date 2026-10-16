import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/api/store.ts';
import { UnitOfWork } from '../../src/api/uow.ts';
import { tableSpec } from '../../src/schema/tables.ts';

const config = tableSpec('app_config');
const profiles = tableSpec('user_profiles');
const ID = '11111111-1111-4111-8111-111111111111';

async function seeded(): Promise<MemoryStore> {
  const store = new MemoryStore();
  const uow = new UnitOfWork(store);
  uow.stage('create', profiles, { id: ID, display_name: 'Old', is_team_member: false, subscription_status: 'none' });
  await uow.commit();
  return store;
}

describe('unit of work', () => {
  it('an update writes only its own columns, so a concurrent change to another column survives', async () => {
    const store = await seeded();
    const a = new UnitOfWork(store);
    const b = new UnitOfWork(store);
    const rowA = (await a.get(profiles, ID))!;
    const rowB = (await b.get(profiles, ID))!;
    b.stage('update', profiles, { ...rowB, is_team_member: true }, undefined, rowB);
    await b.commit();
    a.stage('update', profiles, { ...rowA, display_name: 'New' }, undefined, rowA);
    await a.commit();
    expect(await store.get(profiles, ID)).toMatchObject({ display_name: 'New', is_team_member: true });
  });

  it('an update that changes nothing writes nothing', async () => {
    const store = await seeded();
    const uow = new UnitOfWork(store);
    const row = (await uow.get(profiles, ID))!;
    uow.stage('update', profiles, { ...row }, undefined, row);
    const before = store.commits;
    await uow.commit();
    expect(store.commits).toBe(before);
  });

  it('reads are cached within an operation but dropped when a guard is taken', async () => {
    const store = new MemoryStore();
    let calls = 0;
    const list = store.list.bind(store);
    store.list = (...args) => (calls++, list(...args));
    const uow = new UnitOfWork(store);
    const f = [{ column: 'key', op: 'eq' as const, value: 'x' }];
    await uow.list(config, f);
    await uow.list(config, f);
    expect(calls).toBe(1);

    const other = new UnitOfWork(store);
    other.stage('create', config, { key: 'x', value: 1 });
    await other.commit();
    expect(await uow.list(config, f)).toEqual([]);
    await uow.guard('scope');
    expect(await uow.list(config, f)).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
