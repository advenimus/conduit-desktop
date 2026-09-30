// @vitest-environment node
import { describe, it, expect } from 'vitest';

interface Dialog {
  title: string;
  text: string;
}

// The harness is plain .mjs without type declarations.
const flows = (await import('../verify/lib/sync-flows.mjs' as string)) as {
  waitForDisplaced(device: unknown, opts?: { timeoutMs?: number }): Promise<Dialog>;
  displacedShown(device: unknown): Promise<boolean>;
};
const baseFlows = (await import('../verify/lib/flows.mjs' as string)) as {
  waitForUnlockOutcome(device: unknown, opts?: { timeoutMs?: number }): Promise<{ outcome: string }>;
};

const OVERLAY: Dialog = { title: 'Opened on Mac Mini', text: 'Opened on Mac Mini\n\nSaving your last changes...\n\nYour open connections keep running.' };
const MODAL: Dialog = {
  title: 'Opened on Mac Mini',
  text: 'Opened on Mac Mini\n\nThis vault is now open on Mac Mini.\n\nYour changes from this device were saved.\n\nOK\nUse here instead',
};

/** A device whose page shows `frames` in order, one per dialog read, then keeps the last one. */
function fakeDevice(frames: Dialog[][]) {
  let reads = 0;
  return {
    name: 'a',
    page: { evaluate: async () => frames[Math.min(reads++, frames.length - 1)] },
  };
}

describe('waitForDisplaced', () => {
  it('waits out the "Saving your last changes..." overlay and returns the soft-lock modal', async () => {
    const device = fakeDevice([[OVERLAY], [OVERLAY], [MODAL]]);
    const dialog = await flows.waitForDisplaced(device, { timeoutMs: 5_000 });
    expect(dialog).toEqual(MODAL);
  });

  it('times out when the overlay never gives way to the modal', async () => {
    const device = fakeDevice([[OVERLAY]]);
    await expect(flows.waitForDisplaced(device, { timeoutMs: 600 })).rejects.toThrow(/displaced modal past "Saving your last changes\.\.\."/);
  });

  it('returns a plan-limit modal at once', async () => {
    const planLimit = { title: 'Vault locked', text: 'Vault locked\n\nYour plan now allows this vault on one device at a time.' };
    const device = fakeDevice([[planLimit]]);
    expect(await flows.waitForDisplaced(device, { timeoutMs: 600 })).toEqual(planLimit);
  });
});

/**
 * A main screen whose vault is unlocked (vault_is_unlocked) from the first read, while
 * sync_get_state names no vault for the first `pendingReads` reads: the open is still finishing.
 */
function openingDevice(pendingReads: number) {
  const reads = { syncState: 0 };
  const ipc: Record<string, () => unknown> = {
    vault_is_unlocked: () => true,
    sync_get_state: () => ({ vault: reads.syncState++ < pendingReads ? null : { lineageId: 'L1', path: '/v/Vault.conduit' } }),
  };
  const evaluate = async (fn: unknown, arg?: unknown) => {
    if (arg !== null && typeof arg === 'object' && 'channel' in arg) return { ok: true, value: ipc[(arg as { channel: string }).channel]() };
    if (typeof fn === 'string') return false;
    if (typeof arg === 'string') return [];
    return 'Welcome back\n2 entries';
  };
  return { reads, device: { name: 'a', page: { evaluate } } };
}

describe('waitForUnlockOutcome', () => {
  it('reports unlocked only once sync_get_state names the opened vault', async () => {
    const { reads, device } = openingDevice(2);
    expect(await baseFlows.waitForUnlockOutcome(device, { timeoutMs: 5_000 })).toEqual({ outcome: 'unlocked' });
    expect(reads.syncState).toBe(3);
  });

  it('keeps waiting while the working copy is open but the open has not finished', async () => {
    const { device } = openingDevice(Number.POSITIVE_INFINITY);
    await expect(baseFlows.waitForUnlockOutcome(device, { timeoutMs: 600 })).rejects.toThrow(/unlock outcome/);
  });
});

describe('displacedShown', () => {
  it('counts the overlay as displaced, since vault access is already blocked then', async () => {
    expect(await flows.displacedShown(fakeDevice([[OVERLAY]]))).toBe(true);
    expect(await flows.displacedShown(fakeDevice([[]]))).toBe(false);
  });
});
