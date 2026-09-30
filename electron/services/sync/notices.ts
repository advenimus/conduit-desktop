/**
 * Local notices (spec 3.2 local.json notices[], 4.3 dropped settings, 4.8 undecryptable
 * secrets, 5.10 mass change, 7.1 local items) and one-shot toasts (copy merged, rebind with
 * Undo, side-file reminder, regression back-off, network root). Persisted notices live in
 * local.json through the replica; both kinds reach the renderer as `sync:notice`. Local items
 * never decide data.
 */

import type { ReplicaPort } from './replica.js';
import type { SyncHost, SyncNoticeEvent, TransientNotice, TransientNoticeKind } from './host.js';
import { SYNC_LOG_PREFIX } from './host.js';
import { regKeyStr } from './state-view.js';
import type { LocalJson, LocalNotice } from './types.js';

/** Oldest persisted notices are dropped beyond this count. */
export const NOTICE_MAX_KEPT = 100;

export type NewLocalNotice = Omit<LocalNotice, 'id' | 'createdMs'>;

export interface NoticesPort {
  /**
   * Persists and emits one notice. A notice equal in (kind, key, sourceSha256) to a stored one
   * is not added again; returns null then.
   */
  add(input: NewLocalNotice): LocalNotice | null;
  /** Persists notices produced by core captures (CaptureResult.notices), same dedupe rule. */
  addFromCapture(notices: readonly LocalNotice[]): readonly LocalNotice[];
  dismiss(id: string): boolean;
  list(): readonly LocalNotice[];
  /** Emits a toast (not persisted). */
  toast(kind: TransientNoticeKind, params: TransientNotice['params']): TransientNotice;
  /**
   * Throttle for reminders: true (and records the time, in memory) when `key` was not
   * reminded within `intervalMs`.
   */
  remindDue(key: string, intervalMs: number): boolean;
}

/**
 * In-memory reminder times. One process-wide instance by default, so a reminder such as the
 * network-root warning shows once per launch even though Notices is rebuilt at every unlock.
 */
export class ReminderRegistry {
  private readonly last = new Map<string, number>();

  due(key: string, nowMs: number, intervalMs: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && nowMs - prev < intervalMs && nowMs >= prev) return false;
    this.last.set(key, nowMs);
    return true;
  }
}

const processReminders = new ReminderRegistry();

export interface NoticesDeps {
  readonly replica: Pick<ReplicaPort, 'lineageId' | 'local' | 'updateLocal'>;
  readonly host: Pick<SyncHost, 'clock' | 'random' | 'events' | 'logger'>;
  /** Defaults to the process-wide registry. */
  readonly reminders?: ReminderRegistry;
}

/** Dedupe identity of a notice: (kind, register key, source SHA-256). */
export function noticeDedupeKey(n: Pick<LocalNotice, 'kind' | 'key' | 'sourceSha256'>): string {
  return JSON.stringify([n.kind, n.key === null ? '' : regKeyStr(n.key), n.sourceSha256 ?? '']);
}

/** Keeps the NOTICE_MAX_KEPT newest by createdMs; the survivors keep their order. */
export function capNewest(list: readonly LocalNotice[], max: number = NOTICE_MAX_KEPT): readonly LocalNotice[] {
  if (list.length <= max) return list;
  const dropIds = new Set(
    list
      .map((n, i) => ({ n, i }))
      .sort((a, b) => a.n.createdMs - b.n.createdMs || a.i - b.i)
      .slice(0, list.length - max)
      .map((x) => x.n.id),
  );
  return list.filter((n) => !dropIds.has(n.id));
}

function validateInput(input: NewLocalNotice): void {
  if (!Number.isSafeInteger(input.count) || input.count < 0) {
    throw new Error(`${SYNC_LOG_PREFIX} notice count must be a non-negative integer`);
  }
}

export class Notices implements NoticesPort {
  private readonly reminders: ReminderRegistry;

  constructor(private readonly deps: NoticesDeps) {
    this.reminders = deps.reminders ?? processReminders;
  }

  add(input: NewLocalNotice): LocalNotice | null {
    validateInput(input);
    const notice: LocalNotice = {
      id: this.deps.host.random.uuid(),
      kind: input.kind,
      key: input.key,
      createdMs: this.deps.host.clock.now(),
      sourceSha256: input.sourceSha256,
      count: input.count,
    };
    const added = this.persist([notice]);
    return added[0] ?? null;
  }

  addFromCapture(notices: readonly LocalNotice[]): readonly LocalNotice[] {
    for (const n of notices) validateInput(n);
    return this.persist(notices);
  }

  dismiss(id: string): boolean {
    if (!this.list().some((n) => n.id === id)) return false;
    this.write((l) => ({ ...l, notices: l.notices.filter((n) => n.id !== id) }));
    return true;
  }

  list(): readonly LocalNotice[] {
    return this.deps.replica.local().notices;
  }

  toast(kind: TransientNoticeKind, params: TransientNotice['params']): TransientNotice {
    const notice: TransientNotice = Object.freeze({
      id: this.deps.host.random.uuid(),
      kind,
      createdMs: this.deps.host.clock.now(),
      params: Object.freeze({ ...params }),
    });
    this.emit({ lineageId: this.deps.replica.lineageId, persisted: false, notice });
    return notice;
  }

  remindDue(key: string, intervalMs: number): boolean {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new Error(`${SYNC_LOG_PREFIX} reminder interval must be a non-negative number`);
    }
    return this.reminders.due(`${this.deps.replica.lineageId}:${key}`, this.deps.host.clock.now(), intervalMs);
  }

  /** One local.json write for the batch; every notice actually added is emitted. */
  private persist(incoming: readonly LocalNotice[]): readonly LocalNotice[] {
    const existing = this.list();
    const seen = new Set(existing.map(noticeDedupeKey));
    const ids = new Set(existing.map((n) => n.id));
    const added: LocalNotice[] = [];
    for (const n of incoming) {
      const key = noticeDedupeKey(n);
      if (seen.has(key)) continue;
      seen.add(key);
      const id = n.id !== '' && !ids.has(n.id) ? n.id : this.deps.host.random.uuid();
      ids.add(id);
      added.push(id === n.id ? n : { ...n, id });
    }
    if (added.length === 0) return [];
    const written = this.write((l) => ({ ...l, notices: capNewest([...l.notices, ...added]) }));
    const kept = new Set(written.notices.map((n) => n.id));
    const survivors = added.filter((n) => kept.has(n.id));
    for (const notice of survivors) this.emit({ lineageId: this.deps.replica.lineageId, persisted: true, notice });
    return survivors;
  }

  private write(fn: (l: LocalJson) => LocalJson): LocalJson {
    try {
      return this.deps.replica.updateLocal(fn);
    } catch (err) {
      this.deps.host.logger.error(`${SYNC_LOG_PREFIX} notices: local.json write failed`, { name: (err as Error).name });
      throw err;
    }
  }

  /** A renderer that went away must not break sync: log and continue. */
  private emit(event: SyncNoticeEvent): void {
    try {
      this.deps.host.events.emit('sync:notice', event);
    } catch (err) {
      this.deps.host.logger.error(`${SYNC_LOG_PREFIX} notice event failed`, { kind: event.notice.kind, name: (err as Error).name });
    }
  }
}
