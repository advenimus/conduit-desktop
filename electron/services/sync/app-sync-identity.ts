/**
 * Per-launch identity of the sync layer (spec 3.1, 3.2): syncRoot from the
 * app's data folder, hw_hint, device.json, the machine folder, a fresh session nonce, the
 * process-lifetime incarnation registry, and this build's first launch time (5.5 upgrade
 * wording). Computed once at app start by the app sync manager.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SYNC_LOG_PREFIX, type SyncLogger } from './host.js';
import { defaultHwHintSources, loadOrCreateDevice, newSessionNonce, readHwHint, type HwHintSources } from './identity.js';
import { ensurePrivateRoot, machineDir as machineDirOf, pathEnvFrom, syncRoot as syncRootOf, writeFileAtomic, type EnvName } from './paths.js';
import { IncarnationRegistry } from './replica.js';
import type { SessionConfig } from '../vault-session/host.js';

/** {syncRoot}/builds.json: app version -> first launch ms on this computer. */
export const BUILDS_FILE = 'builds.json';
/** Newest build entries kept in builds.json. */
export const BUILDS_KEEP = 20;
const ENV_NAMES: ReadonlySet<string> = new Set<EnvName>(['conduit', 'conduit-dev']);

export interface LaunchIdentityInput {
  /** env-config getDataDir(): {appData}/{AppFolder}/{conduit | conduit-dev}. */
  readonly dataDir: string;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly appVersion: string;
  readonly nowMs: number;
  readonly randomUuid: () => string;
  readonly logger: SyncLogger;
  readonly hwHintSources?: HwHintSources;
}

export interface LaunchIdentity {
  readonly syncRoot: string;
  readonly machineDir: string;
  readonly deviceUuid: string;
  readonly hwHint: string;
  readonly sessionNonce: string;
  readonly config: SessionConfig;
  readonly incarnations: IncarnationRegistry;
  /** First launch of this build here (null when builds.json could not be written). */
  readonly firstLaunchMs: number | null;
}

/** The data folder name is the environment name (env-config getDataDirName). */
export function envNameOf(dataDir: string): EnvName {
  const name = path.basename(dataDir);
  if (!ENV_NAMES.has(name)) throw new Error(`${SYNC_LOG_PREFIX} unexpected data folder name: ${name}`);
  return name as EnvName;
}

function safeHwHint(input: LaunchIdentityInput): string | null {
  try {
    return readHwHint(input.hwHintSources ?? defaultHwHintSources(input.platform));
  } catch (err) {
    input.logger.warn(`${SYNC_LOG_PREFIX} machine id unavailable; using a random machine id`, { name: (err as Error)?.name ?? 'Error' });
    return null;
  }
}

function readBuilds(file: string): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Records this build's first launch; returns it (null when the file cannot be written). */
export function recordFirstLaunch(root: string, appVersion: string, nowMs: number, logger: SyncLogger): number | null {
  const file = path.join(root, BUILDS_FILE);
  const builds = readBuilds(file);
  const known = builds[appVersion];
  if (known !== undefined) return known;
  const next = Object.fromEntries(
    Object.entries({ ...builds, [appVersion]: nowMs })
      .sort((a, b) => b[1] - a[1])
      .slice(0, BUILDS_KEEP),
  );
  try {
    fs.mkdirSync(root, { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return nowMs;
  } catch (err) {
    logger.warn(`${SYNC_LOG_PREFIX} builds.json not written`, { code: (err as NodeJS.ErrnoException)?.code ?? null });
    return null;
  }
}

export function loadLaunchIdentity(input: LaunchIdentityInput): LaunchIdentity {
  const envName = envNameOf(input.dataDir);
  const appRoot = path.dirname(input.dataDir);
  const pathEnv = pathEnvFrom({
    platform: input.platform,
    home: input.home,
    appDataDir: path.dirname(appRoot),
    appFolder: path.basename(appRoot),
    env: input.env,
  });
  const root = syncRootOf(pathEnv, envName);
  const chmodError = ensurePrivateRoot(root);
  if (chmodError !== null) input.logger.warn(`${SYNC_LOG_PREFIX} could not make the sync folder owner-only`, { code: chmodError.code ?? null });
  const device = loadOrCreateDevice(root, safeHwHint(input), input.randomUuid);
  if (device.created) input.logger.info(`${SYNC_LOG_PREFIX} device identity created`, { reason: device.reason });
  const machineDir = machineDirOf(root, device.hwHint);
  const sessionNonce = newSessionNonce(input.randomUuid);
  return {
    syncRoot: root,
    machineDir,
    deviceUuid: device.deviceUuid,
    hwHint: device.hwHint,
    sessionNonce,
    config: { syncRoot: root, machineDir, dataDir: input.dataDir, deviceUuid: device.deviceUuid, sessionNonce },
    incarnations: new IncarnationRegistry(),
    firstLaunchMs: recordFirstLaunch(root, input.appVersion, input.nowMs, input.logger),
  };
}
