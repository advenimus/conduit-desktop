// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lineageForPath } from '../app-sync-lineage.js';
import { makeTempRoot } from './host-fakes.js';
import { bindingFor, makeDevice, newVaultSeed, open } from './replica-fixtures.js';

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('lineageForPath (spec 5.9 biometric keys)', () => {
  it.skipIf(process.platform === 'win32')('finds the binding of a missing file reached through a symlinked folder', async () => {
    const root = makeTempRoot('lineage-lookup');
    roots.push(root);
    const d = makeDevice(root);
    const realDir = path.join(root, 'real');
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, path.join(root, 'alias'));
    const realShared = path.join(realDir, 'Vault.conduit');
    const nv = newVaultSeed(d);
    const opened = await open(d, nv.lineageId, nv.key, nv.seed, bindingFor(realShared));
    opened.replica.close();

    const viaAlias = path.join(root, 'alias', 'Vault.conduit');
    expect(fs.existsSync(viaAlias)).toBe(false);
    const deps = { machineDir: d.machineDir, stagingDir: path.join(d.syncRoot, 'tmp'), replicaDeps: d.deps, host: d.t.host };
    expect(await lineageForPath(viaAlias, deps)).toBe(nv.lineageId);
  });
});
