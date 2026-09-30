/**
 * Validation of the argument objects the renderer sends to the dashboard channels
 * (docs/DASHBOARD.md 9.2). Anything malformed is rejected with Error("Invalid request").
 */

import type {
  HistoryEndOutcome,
  HistoryEndRequest,
  HistoryForEntryRequest,
  HistoryProtocol,
  HistoryStartRequest,
  ReachabilityRequest,
} from './dashboard-dto.js';

export const INVALID_REQUEST_MESSAGE = 'Invalid request';
export const MAX_ID_LENGTH = 128;

const PROTOCOLS: readonly HistoryProtocol[] = ['ssh', 'rdp', 'vnc', 'web', 'command'];
const END_OUTCOMES: readonly HistoryEndOutcome[] = ['closed', 'dropped', 'failed'];

export type DashboardArgs = Readonly<Record<string, unknown>>;

export class InvalidDashboardRequest extends Error {
  constructor() {
    super(INVALID_REQUEST_MESSAGE);
    this.name = 'InvalidDashboardRequest';
  }
}

/** A channel called without arguments gets an empty object. */
export function argsObject(raw: unknown): DashboardArgs {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidDashboardRequest();
  return raw as DashboardArgs;
}

function requireId(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_ID_LENGTH) throw new InvalidDashboardRequest();
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new InvalidDashboardRequest();
  return v as T;
}

/** Missing gives `fallback`; a finite number is floored and clamped to 1..max; anything else is invalid. */
export function clampLimit(v: unknown, fallback: number, max: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new InvalidDashboardRequest();
  return Math.min(max, Math.max(1, Math.floor(v)));
}

export function parseHistoryStart(a: DashboardArgs): HistoryStartRequest {
  return { entryId: requireId(a.entryId), protocol: oneOf(a.protocol, PROTOCOLS) };
}

export function parseHistoryEnd(a: DashboardArgs): HistoryEndRequest {
  return { id: requireId(a.id), outcome: oneOf(a.outcome, END_OUTCOMES) };
}

export function parseHistoryForEntry(a: DashboardArgs, fallback: number, max: number): Required<HistoryForEntryRequest> {
  return { entryId: requireId(a.entryId), limit: clampLimit(a.limit, fallback, max) };
}

export function parseReachability(a: DashboardArgs): ReachabilityRequest {
  return { entryId: requireId(a.entryId) };
}
