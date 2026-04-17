/**
 * Resolve the Conduit data directory for MCP-local state (quota counter, etc).
 *
 * Must match the main app's env-config.ts logic: preview vs production, platform-specific.
 */

import os from 'node:os';
import path from 'node:path';

export function getDataDir(): string {
  const dirName = process.env.CONDUIT_ENV === 'preview' ? 'conduit-dev' : 'conduit';

  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntime) {
    return path.join(xdgRuntime, dirName);
  }

  const home = os.homedir();
  const platform = os.platform();

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', dirName);
  }

  if (platform === 'linux') {
    return path.join(home, '.local', 'share', dirName);
  }

  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      return path.join(appData, dirName);
    }
    return path.join(home, 'AppData', 'Roaming', dirName);
  }

  return path.join('/tmp', dirName);
}
