import { invoke } from "./electron";
import {
  DASHBOARD_CHANNELS,
  type AiActivityRequest,
  type AiActivityResponse,
  type ConnectionHistoryEvent,
  type HistoryClearResponse,
  type HistoryEndRequest,
  type HistoryForEntryRequest,
  type HistoryRecentRequest,
  type HistoryStartRequest,
  type HistoryStartResponse,
  type PasswordAgeItem,
  type ReachabilityRequest,
  type ReachabilityResult,
  type RecentConnection,
} from "../types/dashboard";

const args = (request: object): Record<string, unknown> => ({ ...request });

/** Renderer side of the dashboard IPC (docs/DASHBOARD.md, IPC contracts). Every call rejects with the main process's message. */
export const dashboardApi = {
  historyStart: (request: HistoryStartRequest) =>
    invoke<HistoryStartResponse>(DASHBOARD_CHANNELS.historyStart, args(request)),
  historyEnd: (request: HistoryEndRequest) =>
    invoke<void>(DASHBOARD_CHANNELS.historyEnd, args(request)),
  historyRecent: (request: HistoryRecentRequest = {}) =>
    invoke<RecentConnection[]>(DASHBOARD_CHANNELS.historyRecent, args(request)),
  historyForEntry: (request: HistoryForEntryRequest) =>
    invoke<ConnectionHistoryEvent[]>(DASHBOARD_CHANNELS.historyForEntry, args(request)),
  historyClear: () =>
    invoke<HistoryClearResponse>(DASHBOARD_CHANNELS.historyClear, {}),
  passwordAges: () =>
    invoke<PasswordAgeItem[]>(DASHBOARD_CHANNELS.passwordAges, {}),
  aiActivity: (request: AiActivityRequest = {}) =>
    invoke<AiActivityResponse>(DASHBOARD_CHANNELS.aiActivity, args(request)),
  checkReachability: (request: ReachabilityRequest) =>
    invoke<ReachabilityResult>(DASHBOARD_CHANNELS.reachabilityCheck, args(request)),
};
