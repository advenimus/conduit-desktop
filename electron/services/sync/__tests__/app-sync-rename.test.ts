// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { RENAME_WHILE_OLDER_OPEN_MESSAGE, renameEngineShared } from '../app-sync-flows.js';
import type { EngineVault } from '../app-sync-review.js';

function engineVault(sideFileState: 'none' | 'present' | 'confirmed', serverFlagRecent = false) {
  const renameShared = vi.fn(async (name: string) => ({ sharedPath: `/cloud/${name}`, realpath: `/cloud/${name}`, fileId: 'f' }));
  const parts = {
    binding: { renameShared },
    sideFiles: { view: () => ({ state: sideFileState }) },
    session: { serverSideFilesFlagRecent: () => serverFlagRecent },
    host: { clock: { now: () => 1_000 } },
    status: { update: vi.fn() },
  };
  const engine = { parts: () => parts, exclusive: <T>(fn: () => T) => Promise.resolve().then(fn), trigger: vi.fn() };
  return { v: { engine } as unknown as EngineVault, renameShared };
}

describe('renameEngineShared', () => {
  it('renames when no older Conduit has the file open', async () => {
    const { v, renameShared } = engineVault('none');
    await expect(renameEngineShared(v, 'New.conduit')).resolves.toBe('/cloud/New.conduit');
    expect(renameShared).toHaveBeenCalledWith('New.conduit');
  });

  it('refuses while an older Conduit left side files next to the vault', async () => {
    const { v, renameShared } = engineVault('present');
    await expect(renameEngineShared(v, 'New.conduit')).rejects.toThrow(RENAME_WHILE_OLDER_OPEN_MESSAGE);
    expect(renameShared).not.toHaveBeenCalled();
  });

  it('refuses while another device reported side files recently', async () => {
    const { v, renameShared } = engineVault('none', true);
    await expect(renameEngineShared(v, 'New.conduit')).rejects.toThrow(RENAME_WHILE_OLDER_OPEN_MESSAGE);
    expect(renameShared).not.toHaveBeenCalled();
  });

  it('renames once the user confirmed the older Conduit is closed', async () => {
    const { v } = engineVault('confirmed');
    await expect(renameEngineShared(v, 'New.conduit')).resolves.toBe('/cloud/New.conduit');
  });
});
