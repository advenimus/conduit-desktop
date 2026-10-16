import { Query } from 'node-appwrite';
import { RealtimeSocket } from './realtime-socket.js';

export const DATABASE_ID = 'conduit';

/** Key column and JSON columns of the tables the apps watch; Realtime sends raw Appwrite rows. */
const ROW_SHAPES: Record<string, { key: string | null; json: readonly string[] }> = {
  personal_vault_sessions: { key: null, json: ['busy', 'flags', 'written_vv'] },
  vault_entries: { key: 'id', json: [] },
  vault_folders: { key: 'id', json: [] },
  vault_password_history: { key: 'id', json: [] },
  vault_folder_permissions: { key: 'id', json: [] },
  vault_locks: { key: 'vault_id', json: [] },
};

/** A raw Realtime row in the shape the api function returns for the same table. */
export function decodeRealtimeRow(table: string, payload: Record<string, unknown>): Record<string, unknown> {
  const shape = ROW_SHAPES[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k.startsWith('$')) continue;
    out[k] = shape?.json.includes(k) && typeof v === 'string' ? safeJson(v) : v;
  }
  if (shape?.key) out[shape.key] = payload.$id;
  return out;
}

function safeJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

export type RowEvent = 'INSERT' | 'UPDATE' | 'DELETE';

export function eventKind(events: readonly string[]): RowEvent | null {
  if (events.some((e) => e.endsWith('.create'))) return 'INSERT';
  if (events.some((e) => e.endsWith('.update') || e.endsWith('.upsert'))) return 'UPDATE';
  if (events.some((e) => e.endsWith('.delete'))) return 'DELETE';
  return null;
}

export interface RowChange {
  table: string;
  kind: RowEvent;
  row: Record<string, unknown>;
}

export interface Subscription {
  close(): Promise<void>;
}

export interface RealtimeOptions {
  endpoint: string;
  projectId: string;
  sessionSecret: string;
}

/** Table name from a Realtime event such as tablesdb.conduit.tables.vault_entries.rows.<id>.update. */
export function tableOfEvent(events: readonly string[]): string | null {
  for (const e of events) {
    const m = /^tablesdb\.[^.]+\.tables\.([^.]+)\.rows\./.exec(e);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Watches rows of the given tables whose `equals.column` matches, on one socket, as the signed-in
 * user (row permissions apply). The socket reconnects by itself; onStatus reports its state.
 */
export async function watchRows(
  opts: RealtimeOptions,
  tables: readonly string[],
  equals: { column: string; value: string },
  onChange: (change: RowChange) => void,
  onStatus?: (status: 'open' | 'closed' | 'error') => void,
): Promise<Subscription> {
  const socket = new RealtimeSocket({
    ...opts,
    channels: tables.map((t) => `tablesdb.${DATABASE_ID}.tables.${t}.rows`),
    queries: [Query.equal(equals.column, [equals.value])],
    onEvent: (e) => {
      const kind = eventKind(e.events);
      const table = tableOfEvent(e.events);
      if (!kind || !table || !tables.includes(table)) return;
      onChange({ table, kind, row: decodeRealtimeRow(table, e.payload) });
    },
    onStatus,
  });
  await socket.start();
  return { close: () => socket.close() };
}

/** The supabase-js postgres_changes payload shape the existing handlers read. */
export function asPostgresPayload(change: RowChange): { eventType: RowEvent; new: Record<string, unknown>; old: Record<string, unknown> } {
  return change.kind === 'DELETE'
    ? { eventType: 'DELETE', new: {}, old: change.row }
    : { eventType: change.kind, new: change.row, old: {} };
}
