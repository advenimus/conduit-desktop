/**
 * Step 1 of the unlock sequence (spec 3.2, 6.3, 12 row 63): the vault's realpath and the
 * shared-versus-private decision, through host.fs (paths.isSharedVault semantics). A vault
 * that does not exist yet (create, or S missing while W exists) resolves through its nearest
 * existing parent.
 */

import path from 'node:path';
import { isErrno, isSharedVault } from '../sync/paths.js';
import type { SyncFs } from '../sync/host.js';
import type { OpenDeps } from './open-personal-vault.js';

const CASE_INSENSITIVE: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin']);

export interface VaultLocation {
  readonly realpath: string;
  readonly shared: boolean;
}

function isMissing(err: unknown): boolean {
  return isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR');
}

/** realpath of `p`, or of its nearest existing ancestor joined with the missing tail. */
export async function realpathNearest(p: string, fs: Pick<SyncFs, 'realpath'>): Promise<string> {
  const missing: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(await fs.realpath(cur), ...[...missing].reverse());
    } catch (err) {
      if (!isMissing(err)) throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Path equality with the platform's case folding. */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const fold = CASE_INSENSITIVE.has(platform) ? (s: string) => s.toLowerCase() : (s: string) => s;
  return fold(api.resolve(a)) === fold(api.resolve(b));
}

/** Step 1: realpath + shared decision (paths.resolveVaultLocation semantics, through host.fs). */
export async function resolveVaultLocation(
  vaultPath: string,
  deps: Pick<OpenDeps, 'host' | 'config'>,
): Promise<VaultLocation> {
  const { fs, paths } = deps.host;
  const abs = path.resolve(vaultPath);
  const realpath = await realpathNearest(abs, fs);
  const link = await fs.lstat(abs);
  const dataDirRealpath = await realpathNearest(deps.config.dataDir, fs);
  const shared = isSharedVault({
    vaultRealpath: realpath,
    dataDirRealpath,
    isSymlink: link?.isSymbolicLink ?? false,
    isLocalVolume: !paths.isNetworkPath(realpath),
    platform: paths.platform,
  });
  return { realpath, shared };
}
