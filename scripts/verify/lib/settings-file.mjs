// A device's settings.json on disk: read it, patch it while the device is closed (or before a
// relaunch), and wait for the app to write a key. launchDevice({settings}) patches it at launch.

import fs from 'node:fs';
import path from 'node:path';
import { isLive, liveDevices } from './app.mjs';
import { waitFor } from './ui.mjs';

const SETTINGS_FILE = 'settings.json';

/** settings.json of a device object ({dataDir}) or of a device root (/tmp/cv-<id>/<name>). */
export function settingsPath(deviceOrRoot) {
  if (typeof deviceOrRoot === 'string') return path.join(deviceOrRoot, 'appData', 'conduit', 'conduit-dev', SETTINGS_FILE);
  if (!deviceOrRoot?.dataDir) throw new Error('settingsPath needs a device (with dataDir) or a device root path');
  return path.join(deviceOrRoot.dataDir, SETTINGS_FILE);
}

/** Parsed settings.json, or {} when the device never wrote one. Throws on a malformed file. */
export function readDeviceSettings(deviceOrRoot) {
  const file = settingsPath(deviceOrRoot);
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

function isRunning(deviceOrRoot) {
  if (typeof deviceOrRoot === 'string') return [...liveDevices.values()].some((d) => d.root === deviceOrRoot);
  return isLive(deviceOrRoot);
}

/**
 * Merges `patch` into settings.json (tmp + rename) and returns the new settings. The app rewrites the
 * whole file whenever it saves, so this refuses a running device unless {allowRunning: true}.
 */
export function writeDeviceSettings(deviceOrRoot, patch, { allowRunning = false } = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('writeDeviceSettings needs a plain object patch');
  if (!allowRunning && isRunning(deviceOrRoot)) {
    throw new Error('writeDeviceSettings: the device is running; quit it first, pass {allowRunning: true}, or use launchDevice({settings})');
  }
  const file = settingsPath(deviceOrRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...readDeviceSettings(deviceOrRoot), ...patch };
  const tmp = `${file}.cv-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}

/** Waits until `pred(value)` holds for settings key `key` (for example after a Settings save). */
export function waitForSetting(device, key, pred, { timeoutMs = 15_000 } = {}) {
  return waitFor(() => {
    const value = readDeviceSettings(device)[key];
    if (pred(value)) return { value };
    throw new Error(`${key} is ${JSON.stringify(value)}`);
  }, { timeoutMs, intervalMs: 200, label: `${device.name}: settings.json ${key}` }).then((r) => r.value);
}
