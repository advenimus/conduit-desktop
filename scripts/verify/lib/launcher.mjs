// Writes the per-device launcher app. Electron runs it instead of the repo root so each device gets
// its own appData (and so its own Chromium profile, single-instance lock and Conduit data dir).

import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './run-context.mjs';

const LAUNCHER_MAIN = `import fs from 'node:fs';
import cp from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, View, app, globalShortcut, ipcMain } from 'electron';

const appData = process.env.CV_APPDATA;
const mainJs = process.env.CV_MAIN_JS;
const logFile = process.env.CV_LOG;
if (!appData || !mainJs || !logFile) throw new Error('CV_APPDATA, CV_MAIN_JS and CV_LOG are required');

const JWT = /eyJ[\\w-]{6,}\\.[\\w-]{6,}\\.[\\w-]{6,}/g;
const NAMED = /((?:refresh_token|access_token|password)["']?\\s*[:=]\\s*["']?)[^\\s"'&,}]{8,}/gi;
const redact = (s) => s.replace(JWT, '<jwt>').replace(NAMED, '$1<redacted>');

for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    try {
      fs.appendFileSync(logFile, redact(String(chunk)));
    } catch {
      // A full disk must not take the app down.
    }
    return write(chunk, ...rest);
  };
}

app.setPath('appData', appData);
app.commandLine.appendSwitch('use-mock-keychain');

// Isolation from the real machine: keep the user's conduit:// handler and global shortcut, and
// never reap MCP servers outside this sandbox (the startup reaper scans every process).
app.setAsDefaultProtocolClient = () => true;
app.removeAsDefaultProtocolClient = () => true;
app.isDefaultProtocolClient = () => true;
// Global shortcuts are kept here instead of registered with the OS; __cvShortcut(accelerator) runs one.
const shortcuts = new Map();
globalShortcut.register = (accelerator, callback) => {
  shortcuts.set(accelerator, callback);
  return false;
};
globalThis.__cvShortcut = (accelerator) => {
  const callback = shortcuts.get(accelerator);
  if (!callback) return false;
  callback();
  return true;
};
// A fixed computer name, so screenshots of the sync devices list never carry the real one.
if (process.env.CV_HOSTNAME) {
  const fixed = process.env.CV_HOSTNAME;
  os.hostname = () => fixed;
  const execFileSync = cp.execFileSync;
  cp.execFileSync = (file, args, options) =>
    String(file).endsWith('scutil') && Array.isArray(args) && args.includes('ComputerName') ? \`\${fixed}\\n\` : execFileSync(file, args, options);
}
const execSync = cp.execSync;
cp.execSync = (command, options) =>
  typeof command === 'string' && command.startsWith('ps -axww') ? '' : execSync(command, options);
syncBuiltinESMExports();

// Toast recorder for the harness: the renderer pushes every toast list to the overlay window over
// this channel, and short toasts can come and go before the overlay page has loaded.
globalThis.__cvToasts = { log: [], now: [] };
ipcMain.on('overlay:push-state', (_event, state) => {
  const toasts = Array.isArray(state?.toasts) ? state.toasts : [];
  const rec = globalThis.__cvToasts;
  rec.now = toasts.map((t) => ({ id: t.id, title: t.title, actions: (t.actions ?? []).map((a) => ({ id: a.id, label: a.label })) }));
  for (const t of toasts) {
    if (rec.log.some((x) => x.id === t.id)) continue;
    rec.log.push({ id: t.id, type: t.type, title: t.title, message: t.message ?? null, actions: (t.actions ?? []).map((a) => a.label), at: Date.now() });
  }
});

// Popup menus and the picker close when they lose focus, and a test device is rarely the active app,
// so a device launched with CV_KEEP_POPUPS=1 keeps them open until the harness closes them.
if (process.env.CV_KEEP_POPUPS === '1') {
  app.on('browser-window-created', (_event, win) => {
    win.webContents.once('dom-ready', () => {
      const url = win.webContents.getURL();
      if (url.startsWith('data:text/html') || url.includes('/picker.html')) win.removeAllListeners('blur');
    });
  });
}

// Native views attached to a window, for the restyle suite's freeze rule (G9): a web session's view is
// detached while a dialog covers it.
const attachedViews = new Set();
const addChildView = View.prototype.addChildView;
View.prototype.addChildView = function (child, ...rest) {
  attachedViews.add(child);
  return addChildView.call(this, child, ...rest);
};
const removeChildView = View.prototype.removeChildView;
View.prototype.removeChildView = function (child, ...rest) {
  attachedViews.delete(child);
  return removeChildView.call(this, child, ...rest);
};
globalThis.__cvAttachedWebViews = () => [...attachedViews]
  .filter((v) => v.webContents && !v.webContents.isDestroyed())
  .map((v) => ({ id: v.webContents.id, url: v.webContents.getURL() }));

// Quiet mode (default; CV_QUIET=0 turns it off): test devices stay invisible and click-through, never
// take keyboard focus and show no Dock icon, so a run does not interrupt whoever is using the machine.
// The harness drives pages over CDP, which needs neither OS focus nor a visible window; the switches
// keep invisible windows rendering and their timers at full speed.
if (process.env.CV_QUIET !== '0') {
  for (const sw of ['disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding', 'disable-background-timer-throttling']) {
    app.commandLine.appendSwitch(sw);
  }
  if (process.platform === 'darwin') {
    app.setActivationPolicy('accessory');
    if (app.dock) {
      app.dock.show = () => Promise.resolve();
      app.dock.bounce = () => -1;
    }
  }
  app.focus = () => {};
  const win = BrowserWindow.prototype;
  const setOpacity = win.setOpacity;
  const setIgnoreMouseEvents = win.setIgnoreMouseEvents;
  win.show = function show() {
    return this.showInactive();
  };
  win.focus = function focus() {};
  win.moveTop = function moveTop() {};
  win.setOpacity = function quietOpacity() {};
  win.setIgnoreMouseEvents = function quietIgnoreMouse() {};
  app.on('browser-window-created', (_event, created) => {
    setOpacity.call(created, 0);
    setIgnoreMouseEvents.call(created, true);
    created.webContents.setBackgroundThrottling(false);
  });
}

await import(pathToFileURL(mainJs).href);
`;

export function electronBinary() {
  const rel = fs.readFileSync(path.join(REPO, 'node_modules', 'electron', 'path.txt'), 'utf8').trim();
  return path.join(REPO, 'node_modules', 'electron', 'dist', rel);
}

function linkIfMissing(target, linkPath) {
  if (fs.existsSync(linkPath)) return;
  fs.symlinkSync(target, linkPath, 'dir');
}

/** Returns the launcher directory for Electron's app argument. */
export function writeLauncher(root, { version }) {
  const dir = path.join(root, 'launcher');
  fs.mkdirSync(dir, { recursive: true });
  // Same name as the repo's package.json (no productName), so app.getName() and the data dir match dev.
  const pkg = { name: 'conduit', version, private: true, type: 'module', main: 'main.mjs' };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'main.mjs'), LAUNCHER_MAIN);
  // app.getAppPath() is this directory; the app registers <appPath>/mcp/dist/index.js with agents.
  linkIfMissing(path.join(REPO, 'mcp'), path.join(dir, 'mcp'));
  // The RDP engine looks for its helper under <appPath>/freerdp-helper/bundle.
  if (fs.existsSync(path.join(REPO, 'freerdp-helper', 'bundle'))) linkIfMissing(path.join(REPO, 'freerdp-helper'), path.join(dir, 'freerdp-helper'));
  return dir;
}
