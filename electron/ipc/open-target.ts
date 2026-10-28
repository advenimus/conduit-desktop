import fs from 'node:fs';
import { ipcMain, shell } from 'electron';
import { openTarget, type OpenTargetDeps } from '../services/open-target.js';

export const systemOpenDeps: OpenTargetDeps = {
  openExternal: (url) => shell.openExternal(url),
  openPath: (target) => shell.openPath(target),
  showItemInFolder: (target) => shell.showItemInFolder(target),
  exists: (target) => fs.existsSync(target),
};

export function registerOpenTargetHandlers(): void {
  ipcMain.handle('open_target', async (_e, args: { target: string }) => {
    if (typeof args?.target !== 'string') throw new Error('open_target: target must be a string');
    await openTarget(args.target, systemOpenDeps);
  });
}
