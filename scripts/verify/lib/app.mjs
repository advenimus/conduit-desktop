// Launches isolated Conduit devices with playwright-core. Each device has its own HOME, appData,
// data dir and MCP socket under /tmp/cv-<id>/<name>, and a mock keychain.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, dropForeignSignalHandlers } from './run-context.mjs';
import { electronBinary, writeLauncher } from './launcher.mjs';
import { redact } from './redact.mjs';
import { withTimeout } from './ui.mjs';

export { buildForRun, startVite } from './app-build.mjs';
export { electronBinary } from './launcher.mjs';

const require = createRequire(import.meta.url);

const APP_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const LAUNCH_TIMEOUT_MS = 90_000;
const QUIT_TIMEOUT_MS = 25_000;
const BASE_ENV_KEYS = ['PATH', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM'];

/** Devices that are still running, for failure screenshots and cleanup. */
export const liveDevices = new Map();

/** True while this device object (not an earlier launch of the same name) is the running one. */
export function isLive(device) {
  return liveDevices.get(device.name) === device;
}

// A relaunch reuses the name, so an earlier launch's object must never drop the new one's entry.
function forget(device) {
  if (isLive(device)) liveDevices.delete(device.name);
}

function socketPathFor(home) {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'conduit-dev', 'conduit.sock');
  return path.join(home, '.local', 'share', 'conduit-dev', 'conduit.sock');
}

function existingSettings(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

/**
 * First-run dialogs off by default: onboarding, What's New, engine picker, telemetry. A relaunch of
 * the same device keeps what the app saved before (recent vaults, backup folder, idle lock).
 */
function seedSettings(dataDir, overrides) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'settings.json');
  const settings = {
    onboarding_completed: true,
    last_seen_whats_new_version: APP_VERSION,
    engine_picker_completed: true,
    analytics_opt_out: true,
    ...existingSettings(file),
    ...overrides,
  };
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function deviceEnv(extra) {
  const env = {};
  for (const key of BASE_ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
  env.LANG ??= 'en_US.UTF-8';
  return { ...env, ...extra };
}

function isMainWindow(page, devUrl) {
  const url = page.url();
  return url.startsWith(devUrl) && !/\.html(\?|#|$)/.test(url.slice(devUrl.length));
}

async function mainWindow(app, devUrl) {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = app.windows().find((p) => isMainWindow(p, devUrl));
    if (found) return found;
    await app.waitForEvent('window', { timeout: Math.max(1_000, deadline - Date.now()) }).catch(() => null);
  }
  throw new Error(`No main window loaded ${devUrl} within ${LAUNCH_TIMEOUT_MS / 1000} s`);
}

const COLOR_SCHEMES = [null, 'light', 'dark', 'no-preference'];

/**
 * Playwright's electron.launch option for opts.colorScheme. Left out, Playwright emulates 'light', so a
 * device never sees dark mode or the machine's own mode; null turns the emulation off.
 */
export function colorSchemeOption(opts) {
  if (!Object.hasOwn(opts, 'colorScheme')) return {};
  if (!COLOR_SCHEMES.includes(opts.colorScheme)) throw new Error(`colorScheme must be one of ${COLOR_SCHEMES.map(String).join(', ')}, not ${JSON.stringify(opts.colorScheme)}`);
  return { colorScheme: opts.colorScheme };
}

function attachRendererLog(page, file) {
  const write = (line) => fs.appendFileSync(file, `${redact(line)}\n`);
  page.on('console', (m) => write(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (err) => write(`[pageerror] ${err.stack ?? err.message}`));
  page.on('crash', () => write('[crash] renderer crashed'));
}

/**
 * Launches device `name`. opts.env adds environment (for example CONDUIT_DEV_VAULT_DEVICE_LIMIT),
 * opts.settings overrides seeded settings.json keys, opts.args adds Electron switches, opts.colorScheme
 * sets the emulated system mode ('light', 'dark', 'no-preference', or null for the machine's own).
 * Returns {name, app, page, root, home, dataDir, socketPath, mainLog, rendererLog, pid, run}.
 */
export async function launchDevice(run, env, name, opts = {}) {
  if (liveDevices.has(name)) throw new Error(`Device "${name}" is already running`);
  const scheme = colorSchemeOption(opts);
  const root = run.deviceRoot(name);
  const home = path.join(root, 'home');
  const appData = path.join(root, 'appData');
  const dataDir = path.join(appData, 'conduit', 'conduit-dev');
  fs.mkdirSync(home, { recursive: true });
  seedSettings(dataDir, opts.settings ?? {});
  const launcher = writeLauncher(root, { version: APP_VERSION });
  const mainLog = run.logPath(`${name}.main.log`);
  const rendererLog = run.logPath(`${name}.renderer.log`);

  const { _electron: electron } = require('playwright-core');
  const app = await electron.launch({
    executablePath: electronBinary(),
    args: ['--use-mock-keychain', ...(opts.args ?? []), launcher],
    cwd: root,
    env: deviceEnv({
      HOME: home,
      CONDUIT_ENV: 'preview',
      CONDUIT_DEV_SERVER_URL: env.devServerUrl,
      CV_APPDATA: appData,
      CV_MAIN_JS: env.mainJs,
      CV_LOG: mainLog,
      ...(opts.env ?? {}),
    }),
    timeout: LAUNCH_TIMEOUT_MS,
    ...scheme,
  });
  dropForeignSignalHandlers();
  const pid = app.process().pid;
  const device = { name, app, page: null, root, home, dataDir, socketPath: socketPathFor(home), mainLog, rendererLog, pid, run };
  liveDevices.set(name, device);
  device.stopRegistration = run.onCleanup(`quit device ${name}`, () => quitDevice(device));
  device.page = await mainWindow(app, env.devServerUrl);
  attachRendererLog(device.page, rendererLog);
  await device.page.waitForLoadState('domcontentloaded', { timeout: LAUNCH_TIMEOUT_MS });
  return device;
}

function processGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitGone(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (processGone(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return processGone(pid);
}

/** SIGKILL, for a device stuck on something like a keychain prompt. */
export async function killDevice(device) {
  try {
    process.kill(device.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
  await waitGone(device.pid, 5_000);
  forget(device);
  await device.app.close().catch(() => {});
  return 'killed';
}

/** Normal quit (runs the app's quit flush and lease release); SIGKILL if it takes too long. */
export async function quitDevice(device, { timeoutMs = QUIT_TIMEOUT_MS } = {}) {
  if (!isLive(device) || processGone(device.pid)) {
    forget(device);
    return 'not running';
  }
  await withTimeout(
    device.app.evaluate(({ app }) => {
      setTimeout(() => app.quit(), 50);
    }),
    5_000,
    `quit ${device.name}`,
  ).catch(() => {});
  if (await waitGone(device.pid, timeoutMs)) {
    forget(device);
    await device.app.close().catch(() => {});
    return 'quit';
  }
  return `quit timed out, ${await killDevice(device)}`;
}
