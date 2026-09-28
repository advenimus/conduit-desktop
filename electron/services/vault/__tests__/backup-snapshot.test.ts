// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBackupBytes } from '../backup-snapshot.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-snapshot-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('backup source', () => {
  it('reads the vault file when no snapshot is given', async () => {
    const vaultPath = path.join(root, 'vault.conduit');
    fs.writeFileSync(vaultPath, 'shared file bytes');
    expect((await readBackupBytes({ vaultPath }, root)).toString()).toBe('shared file bytes');
  });

  it('reads a snapshot into a private folder and removes it', async () => {
    const vaultPath = path.join(root, 'vault.conduit');
    fs.writeFileSync(vaultPath, 'shared file bytes');
    let target = '';
    const bytes = await readBackupBytes(
      {
        vaultPath,
        snapshot: async (t) => {
          target = t;
          expect(fs.existsSync(t)).toBe(false);
          if (process.platform !== 'win32') expect(fs.statSync(path.dirname(t)).mode & 0o777).toBe(0o700);
          fs.writeFileSync(t, 'working copy snapshot');
        },
      },
      root,
    );
    expect(bytes.toString()).toBe('working copy snapshot');
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });

  it('removes the temp folder when the snapshot fails', async () => {
    let dir = '';
    const failing = readBackupBytes(
      {
        vaultPath: path.join(root, 'vault.conduit'),
        snapshot: async (t) => {
          dir = path.dirname(t);
          throw new Error('engine stopped');
        },
      },
      root,
    );
    await expect(failing).rejects.toThrow('engine stopped');
    expect(fs.existsSync(dir)).toBe(false);
  });
});
