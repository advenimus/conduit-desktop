// Local Appwrite for verify runs: start the Docker stack if it is down, and redeploy the schema and
// the api function when appwrite/ changed since the last run. Never talks to anything but localhost.
// First-time setup: npm run appwrite:setup (docs/LOCAL_APPWRITE.md).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO } from './run-context.mjs';
import { runCommand } from './proc.mjs';

const APPWRITE_DIR = path.join(REPO, 'appwrite');
const DEPLOY_INPUTS = ['src', 'scripts', 'package.json', 'package-lock.json'];

export function stackDir() {
  if (process.env.CONDUIT_APPWRITE_DIR) return process.env.CONDUIT_APPWRITE_DIR;
  const ssd = '/Volumes/SSD Storage/.conduit-dev/appwrite';
  return fs.existsSync(ssd) ? ssd : path.join(os.homedir(), '.conduit-dev', 'appwrite');
}

export const ENV_FILE = process.env.CONDUIT_APPWRITE_ENV ?? path.join(stackDir(), 'conduit-dev.env');

let cachedEnv = null;

/** APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, CONDUIT_SERVICE_SECRET from the env file. */
export function stackEnv() {
  if (cachedEnv) return cachedEnv;
  if (!fs.existsSync(ENV_FILE)) throw new Error(`${ENV_FILE} not found. Run npm run appwrite:setup first (docs/LOCAL_APPWRITE.md)`);
  const env = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  for (const k of ['APPWRITE_ENDPOINT', 'APPWRITE_PROJECT_ID', 'APPWRITE_API_KEY', 'CONDUIT_SERVICE_SECRET']) {
    if (!env[k]) throw new Error(`${ENV_FILE} has no ${k}; run npm run appwrite:setup again`);
  }
  const host = new URL(env.APPWRITE_ENDPOINT).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') throw new Error(`Refusing: ${env.APPWRITE_ENDPOINT} is not a local stack`);
  return (cachedEnv = env);
}

async function healthy(endpoint) {
  try {
    return (await fetch(`${endpoint}/health/version`, { signal: AbortSignal.timeout(3_000) })).ok;
  } catch {
    return false;
  }
}

function hashTree(dir, hash) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hashTree(full, hash);
    else hash.update(entry.name).update(fs.readFileSync(full));
  }
}

function deployFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const input of DEPLOY_INPUTS) {
    const full = path.join(APPWRITE_DIR, input);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) hashTree(full, hash);
    else hash.update(input).update(fs.readFileSync(full));
  }
  return hash.digest('hex');
}

/** Starts the stack when it is down and deploys appwrite/ when it changed. Returns the stack env. */
export async function ensureLocalAppwrite(log = () => {}) {
  const env = stackEnv();
  if (!(await healthy(env.APPWRITE_ENDPOINT))) {
    const dir = stackDir();
    if (!fs.existsSync(path.join(dir, 'docker-compose.yml'))) throw new Error(`No Appwrite stack in ${dir}. Run npm run appwrite:setup`);
    log(`starting local Appwrite in ${dir}`);
    await runCommand('docker', ['compose', 'up', '-d'], { cwd: dir, timeoutMs: 300_000, label: 'docker compose up' });
    await runCommand('docker', ['start', 'conduit-appwrite-mailpit'], { allowFailure: true, label: 'mailpit' });
    const until = Date.now() + 180_000;
    while (!(await healthy(env.APPWRITE_ENDPOINT))) {
      if (Date.now() > until) throw new Error('local Appwrite did not come up within 3 minutes');
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  if (!fs.existsSync(path.join(APPWRITE_DIR, 'node_modules'))) {
    log('installing appwrite/ dependencies');
    await runCommand('npm', ['ci', '--no-audit', '--no-fund'], { cwd: APPWRITE_DIR, timeoutMs: 300_000, label: 'npm ci (appwrite)' });
  }
  const stamp = path.join(stackDir(), `.deployed-${env.APPWRITE_PROJECT_ID}`);
  const fingerprint = deployFingerprint();
  if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== fingerprint) {
    log('deploying schema and the api function');
    await runCommand(process.execPath, [path.join(APPWRITE_DIR, 'scripts', 'deploy.ts'), '--seed'], {
      cwd: APPWRITE_DIR,
      env: { ...process.env, ...env },
      timeoutMs: 600_000,
      label: 'appwrite deploy',
    });
    fs.writeFileSync(stamp, fingerprint);
  }
  return env;
}
