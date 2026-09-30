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

describe('displacedShown', () => {
  it('counts the overlay as displaced, since vault access is already blocked then', async () => {
    expect(await flows.displacedShown(fakeDevice([[OVERLAY]]))).toBe(true);
    expect(await flows.displacedShown(fakeDevice([[]]))).toBe(false);
  });
});
