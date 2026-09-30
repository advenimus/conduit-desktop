// One verify run: ids, directories, short app-data roots, free ports and the cleanup registry.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const VERIFY_DIR = path.join(REPO, '.verify');

const DEVICE_NAME = /^[a-z][a-z0-9-]{0,11}$/;
const CLEANUP_STEP_TIMEOUT_MS = 45_000;
// macOS caps Unix socket paths at 104 bytes; the MCP socket lives deep under each device root.
const MAX_SOCKET_PATH = 100;
const RESERVED_PORTS = new Set([1420, 54321, 54322, 54323, 54324]);

const KEEP_RUNS = 20;
const RUN_DIR_NAME = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

/** Keeps the newest KEEP_RUNS run directories under .verify/. */
function pruneOldRuns() {
  if (!fs.existsSync(VERIFY_DIR)) return;
  const runs = fs.readdirSync(VERIFY_DIR).filter((n) => RUN_DIR_NAME.test(n)).sort();
  for (const name of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) {
    fs.rmSync(path.join(VERIFY_DIR, name), { recursive: true, force: true });
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

function tmpBase() {
  return process.platform === 'win32' ? os.tmpdir() : '/tmp';
}

function listen(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ port, host, exclusive: true }, () => {
      const { port: bound } = server.address();
      server.close(() => resolve(bound));
    });
  });
}

async function portFreeOn(port, host) {
  try {
    await listen(port, host);
    return true;
  } catch (err) {
    // No IPv6 loopback on this machine: nothing can hold the port there.
    return err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT';
  }
}

/** A TCP port free on both loopback families (Vite binds "localhost", which may be ::1). */
export async function freePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await listen(0, '127.0.0.1');
    if (RESERVED_PORTS.has(port)) continue;
    if (await portFreeOn(port, '::1')) return port;
  }
  throw new Error('Could not find a free TCP port after 20 attempts');
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createCleanupRegistry(log) {
  const tasks = [];
  let running = null;

  function onCleanup(label, fn) {
    const task = { label, fn, done: false };
    tasks.push(task);
    return async () => {
      if (task.done) return;
      task.done = true;
      await fn();
    };
  }

  async function drain() {
    const failures = [];
    while (tasks.length > 0) {
      const task = tasks.pop();
      if (task.done) continue;
      task.done = true;
      try {
        await withTimeout(Promise.resolve().then(task.fn), CLEANUP_STEP_TIMEOUT_MS, `cleanup "${task.label}"`);
        log(`cleanup ok: ${task.label}`);
      } catch (err) {
        failures.push({ label: task.label, error: String(err?.message ?? err) });
        log(`cleanup FAILED: ${task.label}: ${err?.message ?? err}`);
      }
    }
    return failures;
  }

  function runCleanup() {
    running ??= drain();
    return running;
  }

  return { onCleanup, runCleanup };
}

/**
 * Creates the run directory tree and the cleanup registry. Nothing outside .verify/<runId>/ and
 * /tmp/cv-<id>/ is written by the run itself.
 */
export function createRunContext({ keep = false } = {}) {
  pruneOldRuns();
  const shortId = crypto.randomBytes(3).toString('hex');
  const runId = `${timestamp()}-${shortId}`;
  const runDir = path.join(VERIFY_DIR, runId);
  const dirs = {
    logs: path.join(runDir, 'logs'),
    shots: path.join(runDir, 'shots'),
    cloud: path.join(runDir, 'cloud'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const tmpRoot = path.join(tmpBase(), `cv-${shortId}`);
  fs.mkdirSync(tmpRoot, { recursive: true });

  const cleanupLog = path.join(dirs.logs, 'cleanup.log');
  const log = (line) => fs.appendFileSync(cleanupLog, `${new Date().toISOString()} ${line}\n`);
  const { onCleanup, runCleanup } = createCleanupRegistry(log);

  onCleanup(keep ? 'keep device roots (--keep)' : 'remove device roots', () => {
    if (!keep) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  let shotSeq = 0;

  function deviceRoot(name) {
    if (!DEVICE_NAME.test(name)) {
      throw new Error(`Device name "${name}" must be 1-12 lowercase letters, digits or dashes, starting with a letter`);
    }
    const root = path.join(tmpRoot, name);
    const socket = path.join(fs.realpathSync(tmpRoot), name, 'home', 'Library', 'Application Support', 'conduit-dev', 'conduit.sock');
    if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
      throw new Error(`Device root ${root} is too long for the MCP socket path`);
    }
    return root;
  }

  // A device root lasts the whole run, so a name reused by another scenario would inherit its sign-in,
  // settings, recent vaults and device id.
  const deviceOwners = new Map();
  function claimDevice(name, owner) {
    const previous = deviceOwners.get(name);
    if (previous !== undefined && previous !== owner) {
      throw new Error(`Device name "${name}" was already used by ${previous} in this run; give each scenario its own device names`);
    }
    deviceOwners.set(name, owner);
  }

  function nextShotPath(label) {
    shotSeq += 1;
    const safe = label.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
    return path.join(dirs.shots, `${String(shotSeq).padStart(3, '0')}-${safe}.png`);
  }

  return {
    runId,
    shortId,
    runDir,
    logsDir: dirs.logs,
    shotsDir: dirs.shots,
    cloudDir: dirs.cloud,
    resultsPath: path.join(runDir, 'results.json'),
    tmpRoot,
    keep,
    deviceRoot,
    claimDevice,
    nextShotPath,
    logPath: (name) => path.join(dirs.logs, name),
    onCleanup,
    runCleanup,
  };
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const ownSignalHandlers = new Set();

/**
 * Removes signal listeners the harness did not install. playwright-core adds its own on every
 * Electron launch; they close the apps and exit, which would skip the rest of cleanup.
 */
export function dropForeignSignalHandlers() {
  for (const signal of SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!ownSignalHandlers.has(listener)) process.off(signal, listener);
    }
  }
}

/** SIGINT / SIGTERM / SIGHUP still run every cleanup step before exiting. */
export function installSignalHandlers(run, onSignal) {
  let handled = false;
  const handler = (signal) => {
    if (handled) {
      process.exit(130);
    }
    handled = true;
    process.stderr.write(`\n[verify] ${signal}: cleaning up (press Ctrl+C again to abort cleanup)\n`);
    Promise.resolve()
      .then(() => onSignal?.(signal))
      .then(() => run.runCleanup())
      .finally(() => process.exit(130));
  };
  ownSignalHandlers.add(handler);
  for (const signal of SIGNALS) process.on(signal, handler);
}
