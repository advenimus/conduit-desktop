/**
 * App identity setup — must be the first import in main.ts.
 *
 * ES modules evaluate every import before main.ts's own body runs, and some
 * modules resolve userData at import time, which freezes Chromium's profile
 * path. Renaming the dev build here, before those imports, gives it its own
 * profile and single-instance lock so it can run next to an installed Conduit.
 */

import path from 'node:path';
import { app } from 'electron';
import { setDataRoot } from './services/env-config.js';
import { localNetworkAppName } from './services/local-network.js';

// Captured before the rename, so data stays where it has always lived; the
// rename only moves Chromium's own profile.
setDataRoot(path.join(app.getPath('appData'), app.getName()));

if (!app.isPackaged) {
  app.setName(localNetworkAppName(false));
}
