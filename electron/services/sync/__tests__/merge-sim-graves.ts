// Test-only helpers for the merge simulator: graves as materialize derives them (4.6 step 10)
// and a deep clone that mimics a save and reload (prevVhash kept only on heads).
import { LIFE_REG } from '../catalog.js';
import { StateBuilder, headOf, provisional, rowLife } from '../state-view.js';
import type { Grave, SyncState } from '../types.js';
import { cloneState } from './merge-fixtures.js';

function sameGrave(a: Grave | null, b: Grave | null): boolean {
  if (a === null || b === null) return a === b;
  return a.diedMs === b.diedMs && a.diedC === b.diedC && a.diedDev === b.diedDev && a.redacted === b.redacted;
}

/** Recomputes graves from provisional `_life`, keeping redaction only for the same died dot. */
export function applyGraves(state: SyncState): SyncState {
  const b = new StateBuilder(state);
  for (const row of state.rows.values()) {
    let next: Grave | null = null;
    if (rowLife(state, row.key) === 'dead') {
      const died = provisional(LIFE_REG, row.regs.get(LIFE_REG)?.sibs ?? []);
      if (died) {
        const old = row.grave;
        const sameDot = old !== null && old.diedMs === died.ms && old.diedC === died.c && old.diedDev === died.dev;
        next = { diedMs: died.ms, diedC: died.c, diedDev: died.dev, redacted: sameDot && old.redacted };
      }
    }
    if (!sameGrave(row.grave, next)) b.setGrave(row.key, next);
  }
  return b.build();
}

export function clonedSnapshot(state: SyncState): SyncState {
  return cloneState(state, { dropNonHeadPrev: true, head: headOf });
}
