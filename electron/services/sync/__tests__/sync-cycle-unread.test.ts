// @vitest-environment node
// Cycles that end without reading S (spec 5.6, 5.9, 8.1 kill switch), on a started engine with
// the real cycle body, binding and watcher under the fake clock: a missing S is probed once per
// missing episode, not on every 3 s poll, and a kill-switch pause runs one capture pass per change
// of S, not one per poll. Normal cycles resume when S comes back.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MISSING_DEBOUNCE_MS } from '../file-binding.js';
import { STAT_POLL_MS, SharedFileWatcher } from '../file-watch.js';
import { SyncEngine } from '../sync-engine.js';
import type { SyncEngineDeps } from '../sync-engine-types.js';
import { CycleWorld, insert, type CycleDev } from './cycle-fixtures.js';

const WINDOW_MS = 60_000;

let world: CycleWorld;
const engines: SyncEngine[] = [];

afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  expect(await world.dispose()).toEqual([]);
});

interface Watched {
  readonly a: CycleDev;
  readonly engine: SyncEngine;
  /** Advances the clock in stat-poll steps, waiting for each poll's real file IO and its cycle. */
  readonly polls: (ms: number) => Promise<void>;
  readonly cycles: (reason: string) => number;
}

/** `a`'s wired parts in a started engine whose watcher can be awaited; S read and acknowledged once. */
async function watched(label: string): Promise<Watched> {
  world = new CycleWorld();
  const a = await world.solo(label);
  // The engine that published S stops, so its verify cycles do not share this binding and replica.
  await a.engine.stop();
  const watchers: SharedFileWatcher[] = [];
  const createWatcher: SyncEngineDeps['createWatcher'] = (p, listener) => {
    const w = new SharedFileWatcher(p, a.d.t.host, listener);
    watchers.push(w);
    return w;
  };
  const engine = new SyncEngine({ ...a.engine.parts(), createWatcher });
  engines.push(engine);
  engine.start();
  await engine.whenIdle();
  expect((await engine.runCycle('unlock')).kind).toBe('up-to-date');
  const settle = async (): Promise<void> => {
    await Promise.all(watchers.map((w) => w.settled()));
    await engine.whenIdle();
  };
  const polls = async (ms: number): Promise<void> => {
    for (let t = 0; t < ms; t += STAT_POLL_MS) {
      await a.d.t.clock.advance(STAT_POLL_MS);
      await settle();
    }
  };
  const cycles = (reason: string): number =>
    a.d.t.logger.entries.filter((e) => e.message.endsWith('cycle done') && e.meta?.reason === reason).length;
  return { a, engine, polls, cycles };
}

function prompts(w: Watched): string[] {
  return w.engine.parts().status.snapshot().prompts.map((p) => p.kind);
}

describe('cycles that cannot read S do not repeat on every poll', () => {
  // A folder event and the next stat poll can both report one change before its cycle ends, so a
  // change may cost two cycles; what must not happen is a new cycle on every later poll.
  it('a missing S is probed once per missing episode; S coming back resumes normal cycles', async () => {
    const w = await watched('unread-missing');
    const { a } = w;
    const probes = vi.spyOn(w.engine.parts().binding, 'resolveMissing');
    const elsewhere = path.join(a.root, 'elsewhere.conduit');
    fs.renameSync(a.sharedPath, elsewhere);

    await w.polls(MISSING_DEBOUNCE_MS + STAT_POLL_MS * 2);
    expect(probes).toHaveBeenCalledTimes(1);
    expect(prompts(w)).toContain('file-missing');
    const vanished = w.cycles('shared-changed');

    insert(a, ['while-missing']);
    await w.polls(WINDOW_MS);
    expect(probes).toHaveBeenCalledTimes(1);
    expect(w.cycles('shared-changed')).toBe(vanished);
    expect(w.cycles('local-edit')).toBe(1);
    expect(w.cycles('safety-poll')).toBe(1);
    expect(prompts(w)).toContain('file-missing');
    expect(fs.existsSync(a.sharedPath)).toBe(false);

    fs.renameSync(elsewhere, a.sharedPath);
    await w.polls(STAT_POLL_MS);
    expect(w.cycles('shared-changed')).toBeGreaterThan(vanished);
    expect(prompts(w)).not.toContain('file-missing');

    fs.renameSync(a.sharedPath, elsewhere);
    await w.polls(MISSING_DEBOUNCE_MS + STAT_POLL_MS * 2);
    expect(probes).toHaveBeenCalledTimes(2);
    expect(prompts(w)).toContain('file-missing');
  });

  it('the kill switch: capture passes follow changes of S, not every 3 s poll', async () => {
    const w = await watched('unread-kill');
    const { a } = w;
    const fullPasses = vi.spyOn(a.replica, 'fullPass');
    a.d.t.knobs.personalSyncPaused = true;
    const touch = (s: number): void => fs.utimesSync(a.sharedPath, new Date(), new Date(Date.now() + s * 1000));

    touch(5);
    await w.polls(STAT_POLL_MS * 2);
    const first = fullPasses.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await w.polls(STAT_POLL_MS * 12);
    expect(fullPasses).toHaveBeenCalledTimes(first);

    touch(10);
    await w.polls(STAT_POLL_MS * 2);
    const second = fullPasses.mock.calls.length;
    expect(second).toBeGreaterThan(first);
    await w.polls(STAT_POLL_MS * 3);
    expect(fullPasses).toHaveBeenCalledTimes(second);
    expect(w.cycles('safety-poll')).toBe(0);

    a.d.t.knobs.personalSyncPaused = false;
    expect((await w.engine.runCycle('safety-poll')).kind).toBe('up-to-date');
  });
});
