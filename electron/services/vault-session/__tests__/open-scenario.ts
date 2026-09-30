// Shared scenario of the openPersonalVault unit tests: key-epoch states E1/E2 (the real unlock
// policy decides), a shared vault file in <root>/cloud, and small async and file helpers.
import fs from 'node:fs';
import path from 'node:path';
import { createWrap } from '../../sync/key-epoch.js';
import { lineagePaths } from '../../sync/paths.js';
import { flushAsync, makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { LINEAGE, epochKeysFor, makeState, recordFor, seqRandom } from '../../sync/__tests__/key-epoch-fixtures.js';
import { listFiles, makeOpenHarness, syncedClass, type OpenHarness } from './open-harness.js';
import type { SyncState } from '../../sync/types.js';

export const rand = seqRandom(5);
export const E1 = epochKeysFor('pw1', 'salt1');
export const E2 = epochKeysFor('pw2', 'salt2');
export const R1 = recordFor(E1, null, 'salt1', rand);
export const R2 = recordFor(E2, E1, 'salt2', rand);
export const W21 = createWrap(E2, E1, rand);
export const S_E1 = makeState({ current: E1, records: [R1] });
export const S_E2 = makeState({ current: E2, records: [R1, R2], wraps: [W21], epochMs: 5_000 });
export const S_BYTES = Buffer.from('shared file bytes');

export interface Scenario {
  readonly root: string;
  readonly h: OpenHarness;
  readonly vaultPath: string;
}

/** Signed in, S synced at E1 with file id 'file-1', no W; the replica opens at E1. */
export function sharedScenario(label: string): Scenario {
  const root = makeTempRoot(label);
  const h = makeOpenHarness(root);
  const vaultPath = path.join(root, 'cloud', 'Vault.conduit');
  fs.writeFileSync(vaultPath, S_BYTES);
  h.shared.set(vaultPath, { kind: 'ok', bytes: S_BYTES, cls: syncedClass(S_E1, 'file-1') });
  h.replicas.state = S_E1;
  h.replicas.keys = E1;
  h.t.knobs.userId = 'user-1';
  return { root, h, vaultPath };
}

export async function refusal(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the open to fail');
}

/** A W file for LINEAGE whose state the harness returns. */
export function withW(h: OpenHarness, state: SyncState = S_E1): string {
  const lp = lineagePaths(h.config.machineDir, LINEAGE);
  fs.mkdirSync(lp.dir, { recursive: true });
  fs.writeFileSync(lp.working, 'W bytes');
  h.withW.add(LINEAGE);
  h.wStates.set(lp.working, state);
  return lp.working;
}

/** Real time a condition may take while the whole suite runs in parallel (fs work is real). */
const UNTIL_MAX_REAL_MS = 4_000;

/** Real fs promises need event-loop turns before the next fake timer is registered. */
export async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + UNTIL_MAX_REAL_MS;
  while (!cond() && Date.now() < deadline) await flushAsync();
  if (!cond()) throw new Error('condition never became true');
}

export function stagingFiles(h: OpenHarness): string[] {
  return listFiles(path.join(h.config.syncRoot, 'tmp'));
}
