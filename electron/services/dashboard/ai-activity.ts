/**
 * Recent MCP tool calls from the audit log that mcp/src/audit.ts writes (docs/DASHBOARD.md 7.4).
 * Reads a bounded tail of the file and lets only the tool name, outcome, time, duration and
 * id-shaped entry and session ids leave the main process.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AI_ACTIVITY_TAIL_BYTES,
  type AiActivityItem,
  type AiActivityOutcome,
  type AiActivityResponse,
} from './dashboard-dto.js';

export type AppEnvironment = 'preview' | 'production';

const TOOL_RE = /^[a-z0-9_]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OUTCOMES: readonly AiActivityOutcome[] = ['success', 'error', 'rate_limited', 'access_denied'];
const ID_PARAM_TOOL_PREFIXES = ['entry_', 'credential_', 'document_'];

const NOT_FOUND: AiActivityResponse = { items: [], logFound: false };

/** The same path as defaultAuditLogPath in mcp/src/audit.ts. */
export function auditLogPath(home: string = os.homedir()): string {
  return path.join(home, '.config', 'conduit', 'audit.log');
}

export interface ReadAiActivityOptions {
  readonly logPath: string;
  readonly environment: AppEnvironment;
  readonly limit: number;
  readonly tailBytes?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function idOrNull(v: unknown): string | null {
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

/** Lines written before the env field existed belong to production. */
function inEnvironment(env: unknown, environment: AppEnvironment): boolean {
  if (env === undefined) return environment === 'production';
  return env === environment;
}

function entryIdOf(tool: string, params: Record<string, unknown>): string | null {
  const direct = idOrNull(params.entry_id);
  if (direct !== null) return direct;
  return ID_PARAM_TOOL_PREFIXES.some((p) => tool.startsWith(p)) ? idOrNull(params.id) : null;
}

export function parseAuditLine(line: string, environment: AppEnvironment): AiActivityItem | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { timestamp, tool, result } = raw;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return null;
  if (typeof tool !== 'string' || !TOOL_RE.test(tool)) return null;
  if (!isRecord(result) || !(OUTCOMES as readonly unknown[]).includes(result.type)) return null;
  if (!inEnvironment(raw.env, environment)) return null;
  const params = isRecord(raw.parameters) ? raw.parameters : {};
  const duration = raw.duration_ms;
  return {
    at: timestamp,
    tool,
    outcome: result.type as AiActivityOutcome,
    durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : 0,
    entryId: entryIdOf(tool, params),
    sessionId: idOrNull(params.session_id),
  };
}

/** The last `tailBytes` of the file as text; a first line cut by the read start is dropped. */
async function readTail(logPath: string, tailBytes: number): Promise<string | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(logPath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start === 0) return text;
    const firstBreak = text.indexOf('\n');
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  } finally {
    await handle.close();
  }
}

/** Newest first. A missing log or a read error gives { items: [], logFound: false }. */
export async function readAiActivity(opts: ReadAiActivityOptions): Promise<AiActivityResponse> {
  let text: string | null;
  try {
    text = await readTail(opts.logPath, opts.tailBytes ?? AI_ACTIVITY_TAIL_BYTES);
  } catch (err) {
    console.warn('[dashboard] could not read the MCP audit log', { code: (err as NodeJS.ErrnoException)?.code ?? null });
    return NOT_FOUND;
  }
  if (text === null) return NOT_FOUND;
  const items: AiActivityItem[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const item = parseAuditLine(line, opts.environment);
    if (item !== null) items.push(item);
  }
  const newestFirst = items
    .map((item, index) => ({ item, index, ms: Date.parse(item.at) }))
    .sort((a, b) => b.ms - a.ms || b.index - a.index)
    .map((x) => x.item);
  return { items: newestFirst.slice(0, opts.limit), logFound: true };
}
