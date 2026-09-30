/**
 * Status model of one open lineage (spec 5.6 renderer refresh, 5.5 paused wording, 6.8
 * offline badge, 6.11 waiting, 7.2 "N to review"): holds the SyncStatusSnapshot, derives its
 * kind by precedence, keeps the open prompts and other copies, and emits `sync:state-changed`
 * and `sync:conflicts-changed` only when something actually changed. Pure bookkeeping plus the
 * injected emitter.
 */

import type {
  OtherCopyView,
  PauseReason,
  SessionBadge,
  SyncHost,
  SyncPrompt,
  SyncEventMap,
  SyncStatusKind,
  SyncStatusSnapshot,
  WaitingState,
} from './host.js';
import { SYNC_LOG_PREFIX } from './host.js';

export interface StatusFacts {
  readonly cycleRunning: boolean;
  readonly pauseReason: PauseReason | null;
  readonly fileMissing: boolean;
  readonly unreachable: boolean;
  readonly pendingPublish: boolean;
  readonly waiting: WaitingState | null;
  readonly lastError: boolean;
}

/**
 * Precedence: waiting > paused (pauseReason) > file-not-found > offline > syncing (cycle
 * running) > error > pending (pendingPublish) > up-to-date.
 */
export function statusKindFor(facts: StatusFacts): SyncStatusKind {
  if (facts.waiting !== null) return 'waiting';
  if (facts.pauseReason !== null) return 'paused';
  if (facts.fileMissing) return 'file-not-found';
  if (facts.unreachable) return 'offline';
  if (facts.cycleRunning) return 'syncing';
  if (facts.lastError) return 'error';
  if (facts.pendingPublish) return 'pending';
  return 'up-to-date';
}

export type StatusPatch = Partial<
  Pick<
    SyncStatusSnapshot,
    'fileName' | 'pendingPublish' | 'unsyncedOps' | 'lastSyncedMs' | 'backoffUntilMs' | 'networkRoot'
  >
> & {
  readonly cycleRunning?: boolean;
  readonly pauseReason?: PauseReason | null;
  readonly fileMissing?: boolean;
  readonly unreachable?: boolean;
  readonly lastError?: boolean;
};

export interface SyncStatusPort {
  snapshot(): SyncStatusSnapshot;
  update(patch: StatusPatch): void;
  /** Upsert by prompt id. */
  setPrompt(prompt: SyncPrompt): void;
  clearPrompt(id: string): void;
  /** Removes every prompt of a kind (e.g. all 'copy-review' before a rescan). */
  clearPromptKind(kind: SyncPrompt['kind']): void;
  setOtherCopies(copies: readonly OtherCopyView[]): void;
  setWaiting(waiting: WaitingState | null): void;
  setSessionBadge(badge: SessionBadge | null): void;
  /** Emits `sync:conflicts-changed` when the count changed. */
  setConflicts(count: number): void;
}

interface ModelFacts extends StatusFacts {
  readonly fileName: string | null;
  readonly unsyncedOps: number;
  readonly conflictCount: number;
  readonly lastSyncedMs: number | null;
  readonly backoffUntilMs: number | null;
  readonly sessionBadge: SessionBadge | null;
  readonly networkRoot: boolean;
  readonly prompts: readonly SyncPrompt[];
  readonly otherCopies: readonly OtherCopyView[];
}

const INITIAL_FACTS: ModelFacts = {
  cycleRunning: false,
  pauseReason: null,
  fileMissing: false,
  unreachable: false,
  pendingPublish: false,
  waiting: null,
  lastError: false,
  fileName: null,
  unsyncedOps: 0,
  conflictCount: 0,
  lastSyncedMs: null,
  backoffUntilMs: null,
  sessionBadge: null,
  networkRoot: false,
  prompts: [],
  otherCopies: [],
};

function isCount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

function isTimeOrNull(n: number | null): boolean {
  return n === null || (Number.isFinite(n) && n >= 0);
}

/** Rejects values the renderer could not display (programmer errors in the engine). */
function validatePatch(patch: StatusPatch): void {
  if (patch.unsyncedOps !== undefined && !isCount(patch.unsyncedOps)) {
    throw new Error(`${SYNC_LOG_PREFIX} status: unsyncedOps must be a non-negative integer`);
  }
  for (const field of ['lastSyncedMs', 'backoffUntilMs'] as const) {
    const v = patch[field];
    if (v !== undefined && !isTimeOrNull(v)) throw new Error(`${SYNC_LOG_PREFIX} status: ${field} must be a time or null`);
  }
}

/** Only the keys the patch actually sets (an explicit undefined never clears a fact). */
function definedEntries(patch: StatusPatch): Partial<ModelFacts> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out as Partial<ModelFacts>;
}

function upsert(prompts: readonly SyncPrompt[], prompt: SyncPrompt): readonly SyncPrompt[] {
  const at = prompts.findIndex((p) => p.id === prompt.id);
  if (at < 0) return [...prompts, prompt];
  return prompts.map((p, i) => (i === at ? prompt : p));
}

export class SyncStatusModel implements SyncStatusPort {
  private facts: ModelFacts = INITIAL_FACTS;
  private current: SyncStatusSnapshot;
  private lastJson: string;

  constructor(
    private readonly lineageId: string,
    private readonly host: Pick<SyncHost, 'events' | 'clock' | 'logger'>,
  ) {
    this.current = this.build();
    this.lastJson = JSON.stringify(this.current);
  }

  snapshot(): SyncStatusSnapshot {
    return this.current;
  }

  update(patch: StatusPatch): void {
    validatePatch(patch);
    this.apply(definedEntries(patch));
  }

  setPrompt(prompt: SyncPrompt): void {
    if (prompt.id === '') throw new Error(`${SYNC_LOG_PREFIX} status: a prompt needs an id`);
    this.apply({ prompts: upsert(this.facts.prompts, prompt) });
  }

  clearPrompt(id: string): void {
    if (!this.facts.prompts.some((p) => p.id === id)) return;
    this.apply({ prompts: this.facts.prompts.filter((p) => p.id !== id) });
  }

  clearPromptKind(kind: SyncPrompt['kind']): void {
    if (!this.facts.prompts.some((p) => p.kind === kind)) return;
    this.apply({ prompts: this.facts.prompts.filter((p) => p.kind !== kind) });
  }

  setOtherCopies(copies: readonly OtherCopyView[]): void {
    this.apply({ otherCopies: [...copies] });
  }

  setWaiting(waiting: WaitingState | null): void {
    this.apply({ waiting });
  }

  setSessionBadge(badge: SessionBadge | null): void {
    this.apply({ sessionBadge: badge });
  }

  setConflicts(count: number): void {
    if (!isCount(count)) throw new Error(`${SYNC_LOG_PREFIX} status: conflict count must be a non-negative integer`);
    if (count === this.facts.conflictCount) return;
    this.apply({ conflictCount: count });
    this.emit('sync:conflicts-changed', { lineageId: this.lineageId, count });
  }

  private apply(next: Partial<ModelFacts>): void {
    this.facts = { ...this.facts, ...next };
    const snap = this.build();
    const json = JSON.stringify(snap);
    if (json === this.lastJson) return;
    this.current = snap;
    this.lastJson = json;
    this.emit('sync:state-changed', snap);
  }

  private build(): SyncStatusSnapshot {
    const f = this.facts;
    return Object.freeze({
      lineageId: this.lineageId,
      fileName: f.fileName,
      kind: statusKindFor(f),
      pauseReason: f.pauseReason,
      waiting: f.waiting,
      pendingPublish: f.pendingPublish,
      unsyncedOps: f.unsyncedOps,
      conflictCount: f.conflictCount,
      lastSyncedMs: f.lastSyncedMs,
      backoffUntilMs: f.backoffUntilMs,
      sessionBadge: f.sessionBadge,
      networkRoot: f.networkRoot,
      prompts: Object.freeze([...f.prompts]),
      otherCopies: Object.freeze([...f.otherCopies]),
    });
  }

  /** A renderer that went away must not break sync: log and continue. */
  private emit<K extends 'sync:state-changed' | 'sync:conflicts-changed'>(channel: K, payload: SyncEventMap[K]): void {
    try {
      this.host.events.emit(channel, payload);
    } catch (err) {
      this.host.logger.error(`${SYNC_LOG_PREFIX} status event failed`, { channel, name: (err as Error).name });
    }
  }
}
