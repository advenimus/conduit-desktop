/**
 * Records sessions of saved entries in the local connection history (docs/DASHBOARD.md 7.2).
 * Watches the session store and turns status changes into start and end calls. Sessions without
 * an entry id (for example ones MCP tools open) are not recorded.
 */

import { useSessionStore, type Session } from "../stores/sessionStore";
import { dashboardApi } from "./dashboardApi";
import type { HistoryEndOutcome, HistoryProtocol } from "../types/dashboard";

const RECORDABLE: ReadonlySet<string> = new Set<HistoryProtocol>(["ssh", "rdp", "vnc", "web", "command"]);

interface Tracked {
  readonly entryId: string;
  readonly protocol: HistoryProtocol;
  /** null: no vault was open at start, so the end is skipped. */
  rowId: Promise<string | null>;
  reachedConnected: boolean;
  lastStatus: Session["status"];
}

type RecordableSession = Session & { entryId: string; type: HistoryProtocol };

function isRecordable(s: Session): s is RecordableSession {
  return typeof s.entryId === "string" && s.entryId !== "" && RECORDABLE.has(s.type);
}

export interface RecorderApi {
  historyStart: typeof dashboardApi.historyStart;
  historyEnd: typeof dashboardApi.historyEnd;
  historyInterruptOpen: typeof dashboardApi.historyInterruptOpen;
}

/** Starts wait for this, so rows left open by a previous renderer are interrupted first. */
interface Recorder {
  readonly api: RecorderApi;
  readonly ready: Promise<void>;
}

type SessionList = readonly Session[] | null | undefined;

export interface SessionSource {
  getState(): { sessions: SessionList };
  subscribe(listener: (state: { sessions: SessionList }, prev: { sessions: SessionList }) => void): () => void;
}

function startRow({ api, ready }: Recorder, entryId: string, protocol: HistoryProtocol): Promise<string | null> {
  return ready.then(() => api.historyStart({ entryId, protocol })).then(
    (res) => res?.id ?? null,
    (err: unknown) => {
      console.warn("[history] connection_history_start failed", err instanceof Error ? err.message : err);
      return null;
    },
  );
}

function endRow({ api }: Recorder, t: Tracked, outcome: HistoryEndOutcome): void {
  void t.rowId.then((id) => {
    if (id === null) return;
    return api.historyEnd({ id, outcome }).catch((err: unknown) => {
      console.warn("[history] connection_history_end failed", err instanceof Error ? err.message : err);
    });
  });
}

function track(rec: Recorder, s: RecordableSession): Tracked {
  return {
    entryId: s.entryId,
    protocol: s.type,
    rowId: startRow(rec, s.entryId, s.type),
    reachedConnected: s.status === "connected",
    lastStatus: s.status,
  };
}

/** Rules 3 to 5 for a tracked session that is still present. Returns false when it stops being tracked. */
function applyStatus(rec: Recorder, t: Tracked, s: RecordableSession): boolean {
  if (t.lastStatus === "connected" && s.status === "connecting") {
    endRow(rec, t, "closed");
    t.rowId = startRow(rec, t.entryId, t.protocol);
    t.reachedConnected = false;
  }
  if (s.status === "connected") t.reachedConnected = true;
  if (s.status === "disconnected") {
    endRow(rec, t, !t.reachedConnected ? "failed" : s.error ? "dropped" : "closed");
    return false;
  }
  t.lastStatus = s.status;
  return true;
}

/** Pure step over one store change; `tracked` is the recorder's own map. A missing list counts as empty. */
function recordChange(rec: Recorder, tracked: Map<string, Tracked>, sessions: SessionList, prevSessions: SessionList): void {
  const current = new Map<string, RecordableSession>();
  for (const s of sessions ?? []) if (isRecordable(s)) current.set(s.id, s);
  const prevIds = new Set((prevSessions ?? []).map((s) => s.id));

  // Rule 1: an id swap moves the tracking (replaceSessionId).
  const fresh = [...current.values()].filter((s) => !tracked.has(s.id) && !prevIds.has(s.id));
  for (const [id, t] of [...tracked]) {
    if (current.has(id)) continue;
    const i = fresh.findIndex((s) => s.entryId === t.entryId && s.type === t.protocol);
    if (i === -1) {
      // Rule 6: removed.
      endRow(rec, t, "closed");
      tracked.delete(id);
      continue;
    }
    const [swapped] = fresh.splice(i, 1);
    tracked.delete(id);
    tracked.set(swapped.id, t);
  }

  for (const s of current.values()) {
    const t = tracked.get(s.id);
    if (t === undefined) {
      // Rule 2: start.
      if (s.status === "connecting" || s.status === "connected") tracked.set(s.id, track(rec, s));
      continue;
    }
    if (!applyStatus(rec, t, s)) tracked.delete(s.id);
  }
}

/**
 * A new recorder (app start or a renderer reload) cannot end rows an earlier one left open, so it
 * marks them interrupted before its first start.
 */
export function createConnectionHistoryRecorder(source: SessionSource, api: RecorderApi): () => void {
  const ready = api.historyInterruptOpen().then(
    () => undefined,
    (err: unknown) => {
      console.warn("[history] connection_history_interrupt_open failed", err instanceof Error ? err.message : err);
    },
  );
  const rec: Recorder = { api, ready };
  const tracked = new Map<string, Tracked>();
  recordChange(rec, tracked, source.getState().sessions, []);
  return source.subscribe((state, prev) => {
    if (state.sessions === prev.sessions) return;
    recordChange(rec, tracked, state.sessions, prev.sessions);
  });
}

/** Installed once from main.tsx. Returns the unsubscribe. */
export function installConnectionHistoryRecorder(): () => void {
  return createConnectionHistoryRecorder(useSessionStore, dashboardApi);
}
