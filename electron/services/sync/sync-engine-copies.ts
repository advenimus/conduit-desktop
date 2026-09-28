/**
 * What the engine does with a copy scan (spec 5.8): class 3 copies are merged automatically
 * (the scanner toasts and ignores their SHA), class 4 copies become "copy-review" prompts,
 * class 1 copies become the "different copies" prompt of the device that uses them, and every
 * copy that was not merged is listed under "Other copies of this vault".
 */

import { listPresence } from './presence.js';
import type { ScannedCopy } from './copy-scanner.js';
import type { SyncEngineDeps } from './sync-engine-types.js';
import type { OtherCopyView, SyncPrompt } from './host.js';
import { SYNC_LOG_PREFIX } from './host.js';
import type { FileHint } from './types.js';

export function copyView(c: ScannedCopy): OtherCopyView {
  const k = c.contribution;
  return {
    path: c.path,
    name: c.name,
    sha256: c.sha256,
    cls: c.cls,
    changes: k.changedFields + k.onlyInCopy + k.deletions,
    deletions: k.deletions,
  };
}

interface DeviceHint {
  readonly deviceUuid: string;
  readonly deviceName: string;
  readonly theirs: FileHint;
}

/** The device named by a class 1 copy: presence first, then the server's session rows. */
function deviceUsing(deps: SyncEngineDeps, name: string): DeviceHint | null {
  for (const p of listPresence(deps.replica.state())) {
    if (p.deviceUuid === deps.replica.deviceUuid || p.value.name !== name || p.value.file_hint === null) continue;
    return { deviceUuid: p.deviceUuid, deviceName: name, theirs: p.value.file_hint };
  }
  for (const row of deps.session.sessions()) {
    if (row.deviceId === deps.replica.deviceUuid || row.deviceName !== name || row.fileId === null) continue;
    const theirs = { file_id: row.fileId, location: row.location ?? '', file_name: row.fileName ?? '' };
    return { deviceUuid: row.deviceId, deviceName: name, theirs };
  }
  return null;
}

function inUsePrompt(deps: SyncEngineDeps, copy: ScannedCopy): SyncPrompt | null {
  if (copy.inUseBy === null) return null;
  const device = deviceUsing(deps, copy.inUseBy);
  if (device === null) return null;
  return {
    kind: 'different-copies',
    id: `different-copies:${device.deviceUuid}`,
    deviceUuid: device.deviceUuid,
    deviceName: device.deviceName,
    theirs: device.theirs,
    ours: deps.binding.fileHint(),
  };
}

function promptFor(deps: SyncEngineDeps, copy: ScannedCopy, view: OtherCopyView): SyncPrompt | null {
  if (copy.cls === 'needs-review') return { kind: 'copy-review', id: `copy-review:${copy.sha256}`, copy: view };
  if (copy.cls !== 'in-use-elsewhere') return null;
  try {
    return inUsePrompt(deps, copy);
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not name the device using a copy`, { name: (err as Error).name });
    return null;
  }
}

export interface ScanApplied {
  /** Class 3 copies merged into W (a cycle should publish them). */
  readonly merged: number;
}

/** Applies one scan to W and the status model; stops early when the engine stops. */
export async function applyScan(
  deps: SyncEngineDeps,
  copies: readonly ScannedCopy[],
  alive: () => boolean,
): Promise<ScanApplied> {
  const views: OtherCopyView[] = [];
  const prompts: SyncPrompt[] = [];
  let merged = 0;
  for (const copy of copies) {
    if (!alive()) break;
    if (copy.cls === 'safe-provider-copy') {
      const res = await deps.scanner.mergeSafe(copy);
      if (res !== null) merged += 1;
      continue;
    }
    const view = copyView(copy);
    views.push(view);
    const prompt = promptFor(deps, copy, view);
    if (prompt !== null) prompts.push(prompt);
  }
  if (!alive()) return { merged };
  deps.status.clearPromptKind('copy-review');
  for (const p of prompts) deps.status.setPrompt(p);
  deps.status.setOtherCopies(views);
  return { merged };
}
