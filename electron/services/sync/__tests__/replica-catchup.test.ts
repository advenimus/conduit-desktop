// @vitest-environment node
// 4.2 step 6: a write that skipped the hooks (vault_meta writes, importers, MCP) landing between
// the cycle's full pass and a later commit must be captured, never reverted by materialize.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareWrite } from '../capture-local.js';
import { merge } from '../merge.js';
import type { ReplicaPort } from '../replica.js';
import { commitMerge } from '../sync-cycle.js';
import { TBL } from '../types.js';
import { makeTempRoot } from './host-fakes.js';
import { insertEntry, makeDevice, newVaultSeed, open, provisionalOf } from './replica-fixtures.js';

let root: string;
const opened: ReplicaPort[] = [];

beforeEach(() => {
  root = makeTempRoot('replica-catchup');
});

afterEach(() => {
  for (const r of opened.splice(0)) r.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function vaultWithEntry(): Promise<{ r: ReplicaPort; id: string }> {
  const d = makeDevice(root);
  const nv = newVaultSeed(d);
  const r = (await open(d, nv.lineageId, nv.key, nv.seed, null)).replica;
  opened.push(r);
  const id = crypto.randomUUID();
  d.t.workingCopy.last().mutate((db) => insertEntry(db, id, 'box', '10.0.0.1'), { rows: [{ tbl: TBL.entries, rowId: id }], interactive: true });
  r.fullPass();
  return { r, id };
}

function hostOf(r: ReplicaPort, id: string): string {
  return (r.database().prepare('SELECT host FROM entries WHERE id = ?').get(id) as { host: string }).host;
}

function editHostWithoutHook(r: ReplicaPort, id: string, host: string): void {
  r.database().prepare('UPDATE entries SET host = ? WHERE id = ?').run(host, id);
}

function metaValue(r: ReplicaPort, key: string): string | null {
  const row = r.database().prepare('SELECT value FROM vault_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

describe('commits capture writes that skipped the hooks first', () => {
  it('commitMerge keeps a content edit made after the cycle full pass, and the state records it', async () => {
    const { r, id } = await vaultWithEntry();
    const gen0 = r.generation();
    const w = r.state();
    editHostWithoutHook(r, id, '10.9.9.9');
    commitMerge(r, merge(w, w, r.implicit()).state, gen0);
    expect(hostOf(r, id)).toBe('10.9.9.9');
    expect(provisionalOf(r.state(), id, 'host')?.value).toBe('10.9.9.9');
    expect(r.fullPass().changed).toBe(false);
  });

  it('commitMerge keeps a vault_meta write made without the hook', async () => {
    const { r } = await vaultWithEntry();
    const gen0 = r.generation();
    const w = r.state();
    r.database()
      .prepare("INSERT INTO vault_meta(key, value) VALUES ('cloud_sync_enabled', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run();
    commitMerge(r, merge(w, w, r.implicit()).state, gen0);
    expect(metaValue(r, 'cloud_sync_enabled')).toBe('1');
  });

  it('a generation-checked commit reports the catch-up capture as a generation change', async () => {
    const { r, id } = await vaultWithEntry();
    const gen0 = r.generation();
    const w = r.state();
    editHostWithoutHook(r, id, '10.9.9.9');
    expect(r.commitIfGeneration(w, gen0)).toBeNull();
    expect(r.generation()).toBe(gen0 + 1);
    expect(hostOf(r, id)).toBe('10.9.9.9');
  });

  it('applyWrites (presence, claims, publish marker) keeps an edit made without the hook', async () => {
    const { r, id } = await vaultWithEntry();
    editHostWithoutHook(r, id, '10.9.9.9');
    const write = prepareWrite({ tbl: TBL.entries, rowId: id, reg: 'name' }, { value: 'renamed' }, r.context(), 'replace-all');
    r.applyWrites([write], { interactive: true });
    expect(hostOf(r, id)).toBe('10.9.9.9');
    expect(provisionalOf(r.state(), id, 'host')?.value).toBe('10.9.9.9');
    expect(provisionalOf(r.state(), id, 'name')?.value).toBe('renamed');
  });

  it('commitWith (copy merge, candidate apply, resolutions) keeps an edit made without the hook', async () => {
    const { r, id } = await vaultWithEntry();
    editHostWithoutHook(r, id, '10.9.9.9');
    r.commitWith((cur) => cur);
    expect(hostOf(r, id)).toBe('10.9.9.9');
    expect(provisionalOf(r.state(), id, 'host')?.value).toBe('10.9.9.9');
  });
});
