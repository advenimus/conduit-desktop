/**
 * Read-only scans of the machine folder (spec 3.1 binding, 5.11): which lineage is bound to a
 * shared path, whether a lineage has a W, and every lineage's pending_publish. Nothing is
 * parked or rewritten here (only openReplica owns a lineage's local.json).
 * Import through replica.ts.
 */

import path from 'node:path';
import { SYNC_LOG_PREFIX } from './host.js';
import { validateLocalJson } from './local-state.js';
import { LINEAGE_FILES, lineagePaths } from './paths.js';
import type { PendingSummary, ReplicaDeps } from './replica-types.js';
import type { LocalJson } from './types.js';

const CASE_INSENSITIVE: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin']);
const MISSING = new Set(['ENOENT', 'ENOTDIR']);

interface LineageLocal {
  readonly lineageId: string;
  readonly local: LocalJson;
  readonly mtimeMs: number;
}

function codeOf(err: unknown): string | null {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
}

async function listLineageFolders(machineDir: string, deps: ReplicaDeps): Promise<string[]> {
  try {
    return (await deps.host.fs.readdir(machineDir)).sort();
  } catch (err) {
    if (MISSING.has(codeOf(err) ?? '')) return [];
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} cannot list the machine folder`, { code: codeOf(err) });
    throw err;
  }
}

/** A lineage folder's valid local.json, or null (missing, unreadable or invalid: skipped here). */
async function readLineageLocal(machineDir: string, name: string, deps: ReplicaDeps): Promise<LineageLocal | null> {
  const file = path.join(machineDir, name, LINEAGE_FILES.local);
  let text: string;
  let mtimeMs: number;
  try {
    const st = await deps.host.fs.stat(file);
    if (st === null || !st.isFile) return null;
    text = (await deps.host.fs.readFile(file)).toString('utf8');
    mtimeMs = st.mtimeMs;
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} cannot read a lineage local.json`, { lineage: name, code: codeOf(err) });
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} a lineage local.json is not valid JSON; skipped`, { lineage: name });
    return null;
  }
  const v = validateLocalJson(raw);
  if (!v.ok || v.value.lineageId !== name) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} a lineage local.json is invalid; skipped`, { lineage: name });
    return null;
  }
  return { lineageId: name, local: v.value, mtimeMs };
}

async function readAllLocals(machineDir: string, deps: ReplicaDeps): Promise<LineageLocal[]> {
  const out: LineageLocal[] = [];
  for (const name of await listLineageFolders(machineDir, deps)) {
    if (name === LINEAGE_FILES.device || name.startsWith('.')) continue;
    const entry = await readLineageLocal(machineDir, name, deps);
    if (entry !== null) out.push(entry);
  }
  return out;
}

/** Lineage whose local.json binding has this realpath (a pre-sync S is identified by its binding). */
export async function findBoundLineage(machineDir: string, realpath: string, deps: ReplicaDeps): Promise<string | null> {
  const fold = CASE_INSENSITIVE.has(deps.host.paths.platform) ? (p: string) => p.toLowerCase() : (p: string) => p;
  const wanted = fold(realpath);
  let best: LineageLocal | null = null;
  for (const entry of await readAllLocals(machineDir, deps)) {
    const bound = entry.local.binding?.realpath;
    if (bound === undefined || fold(bound) !== wanted) continue;
    if (best === null || entry.mtimeMs > best.mtimeMs) best = entry;
  }
  return best?.lineageId ?? null;
}

/** true when a W exists for the lineage on this machine. */
export async function hasWorkingCopy(machineDir: string, lineageId: string, deps: ReplicaDeps): Promise<boolean> {
  let working: string;
  try {
    working = lineagePaths(machineDir, lineageId).working;
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} a lineage id is not a usable folder name; no working copy`, {
      name: err instanceof Error ? err.name : typeof err,
    });
    return false;
  }
  const st = await deps.host.fs.stat(working);
  return st !== null && st.isFile;
}

/** Every lineage folder's pending_publish (VaultHub "N changes not yet synced", 5.11 start check). */
export async function readPendingSummaries(machineDir: string, deps: ReplicaDeps): Promise<readonly PendingSummary[]> {
  const entries = await readAllLocals(machineDir, deps);
  return entries.map((e) => ({
    lineageId: e.lineageId,
    sharedPath: e.local.binding?.sharedPath ?? null,
    pendingPublish: e.local.pendingPublish,
  }));
}
