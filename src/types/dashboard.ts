/**
 * Home dashboard, connection history, password age, AI activity and reachability (docs/DASHBOARD.md).
 * MIRROR of electron/services/dashboard/dashboard-dto.ts: the text between the
 * MIRROR markers must stay identical in both files. Plain JSON payloads only.
 */

// ---- MIRROR START (keep identical in src/types/dashboard.ts and electron/services/dashboard/dashboard-dto.ts) ----

// ---------- IPC channels (ipcMain.handle in electron/ipc/dashboard.ts, invoke in src/lib/dashboardApi.ts) ----------

export const DASHBOARD_CHANNELS = {
  historyStart: 'connection_history_start',
  historyEnd: 'connection_history_end',
  historyRecent: 'connection_history_recent',
  historyForEntry: 'connection_history_for_entry',
  historyClear: 'connection_history_clear',
  historyInterruptOpen: 'connection_history_interrupt_open',
  passwordAges: 'password_age_list',
  aiActivity: 'ai_activity_recent',
  reachabilityCheck: 'reachability_check',
} as const;

export type DashboardChannel = (typeof DASHBOARD_CHANNELS)[keyof typeof DASHBOARD_CHANNELS];

// ---------- Limits ----------

export const HISTORY_RETENTION_DAYS = 90;
export const HISTORY_MAX_ROWS_PER_VAULT = 5000;
export const HISTORY_RECENT_DEFAULT = 8;
export const HISTORY_RECENT_MAX = 50;
export const HISTORY_ENTRY_DEFAULT = 20;
export const HISTORY_ENTRY_MAX = 100;
export const AI_ACTIVITY_DEFAULT = 20;
export const AI_ACTIVITY_MAX = 100;
/** Bytes read from the end of the MCP audit log per call. */
export const AI_ACTIVITY_TAIL_BYTES = 512 * 1024;
export const REACHABILITY_TIMEOUT_MS = 3000;
/** A second check of the same entry inside this window returns the cached result. */
export const REACHABILITY_MIN_INTERVAL_MS = 2000;
/** Checks the main process runs at once; more wait in a queue. */
export const REACHABILITY_MAX_CONCURRENT = 4;

// ---------- Connection history ----------

/** Entry types whose sessions are recorded. */
export type HistoryProtocol = 'ssh' | 'rdp' | 'vnc' | 'web' | 'command';

/** open: still running. interrupted: the app quit or crashed before the session ended. */
export type HistoryOutcome = 'open' | 'closed' | 'dropped' | 'failed' | 'interrupted';

/** How a session ended, as the renderer reports it. */
export type HistoryEndOutcome = 'closed' | 'dropped' | 'failed';

export interface HistoryStartRequest {
  readonly entryId: string;
  readonly protocol: HistoryProtocol;
}

/** null: no vault is open, so nothing was recorded. */
export type HistoryStartResponse = { readonly id: string } | null;

export interface HistoryEndRequest {
  readonly id: string;
  readonly outcome: HistoryEndOutcome;
}

export interface ConnectionHistoryEvent {
  readonly id: string;
  readonly entryId: string;
  readonly protocol: HistoryProtocol;
  /** ISO 8601, main process clock. */
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** endedAt minus startedAt; null while open or when interrupted. */
  readonly durationMs: number | null;
  readonly outcome: HistoryOutcome;
}

/** One row per entry: its latest event, plus how many events it has in the retention window. */
export interface RecentConnection {
  readonly entryId: string;
  readonly protocol: HistoryProtocol;
  readonly lastStartedAt: string;
  readonly lastEndedAt: string | null;
  readonly lastDurationMs: number | null;
  readonly lastOutcome: HistoryOutcome;
  readonly count: number;
}

export interface HistoryRecentRequest {
  readonly limit?: number;
}

export interface HistoryForEntryRequest {
  readonly entryId: string;
  readonly limit?: number;
}

export interface HistoryClearResponse {
  readonly deleted: number;
}

/** Rows still open when the renderer started; they can no longer be ended, so they read as interrupted. */
export interface HistoryInterruptResponse {
  readonly interrupted: number;
}

// ---------- Password age ----------

/** An entry that stores its own password. history: set at its last password change; created: never changed. */
export interface PasswordAgeItem {
  readonly entryId: string;
  readonly setAt: string;
  readonly source: 'history' | 'created';
}

// ---------- AI activity (MCP audit log) ----------

export type AiActivityOutcome = 'success' | 'error' | 'rate_limited' | 'access_denied';

export interface AiActivityItem {
  /** ISO 8601 from the log line. */
  readonly at: string;
  /** MCP tool name, for example terminal_execute. */
  readonly tool: string;
  readonly outcome: AiActivityOutcome;
  readonly durationMs: number;
  /** From the entry_id (or id) parameter when it looks like an id; never host names or other values. */
  readonly entryId: string | null;
  /** From the session_id parameter when it looks like an id. */
  readonly sessionId: string | null;
}

export interface AiActivityRequest {
  readonly limit?: number;
}

export interface AiActivityResponse {
  /** Newest first. */
  readonly items: readonly AiActivityItem[];
  /** false: there is no audit log on this device yet. */
  readonly logFound: boolean;
}

// ---------- Reachability ("Is it up?") ----------

/**
 * reachable: a TCP connection opened. refused: the host answered but the port is closed.
 * unreachable: no route. timeout: no answer in REACHABILITY_TIMEOUT_MS. not_found: the host name did not resolve.
 * invalid: the entry's host or port is not valid. not_checkable: the entry type has no host and port.
 */
export type ReachabilityStatus =
  | 'reachable'
  | 'refused'
  | 'unreachable'
  | 'timeout'
  | 'not_found'
  | 'invalid'
  | 'not_checkable';

export interface ReachabilityRequest {
  readonly entryId: string;
}

export interface ReachabilityResult {
  readonly entryId: string;
  readonly status: ReachabilityStatus;
  /** The host and port that were checked; null for invalid and not_checkable. */
  readonly host: string | null;
  readonly port: number | null;
  /** Time to open the connection; only for reachable. */
  readonly latencyMs: number | null;
  readonly checkedAt: string;
}

// ---- MIRROR END ----

// ---------- Renderer only: Home layout and settings ----------

export type HomeSectionId = 'quick' | 'recent' | 'open-now' | 'favorites' | 'attention' | 'ai-activity' | 'vault-status';

/** Display order, top to bottom. */
export const HOME_SECTION_IDS: readonly HomeSectionId[] = [
  'quick',
  'recent',
  'open-now',
  'favorites',
  'attention',
  'ai-activity',
  'vault-status',
];

/** Labels in the Customize menu. */
export const HOME_SECTION_LABELS: Readonly<Record<HomeSectionId, string>> = {
  quick: 'Search and quick actions',
  recent: 'Recently connected',
  'open-now': 'Open now',
  favorites: 'Favorites',
  attention: 'Needs attention',
  'ai-activity': 'AI activity',
  'vault-status': 'Vault status',
};

/** Persisted per device with ui_state_set under HOME_SETTINGS_KEY. */
export interface HomeSettings {
  readonly version: 1;
  readonly hidden: readonly HomeSectionId[];
  /** Warn about passwords older than this many days; null never warns. */
  readonly passwordAgeDays: number | null;
  /** Warn when the last backup is older than this many days. */
  readonly backupStaleDays: number;
}

export const HOME_SETTINGS_KEY = 'home-dashboard';

export const DEFAULT_HOME_SETTINGS: HomeSettings = {
  version: 1,
  hidden: [],
  passwordAgeDays: 180,
  backupStaleDays: 7,
};

export const PASSWORD_AGE_OPTIONS: readonly (number | null)[] = [90, 180, 365, null];
export const BACKUP_STALE_OPTIONS: readonly number[] = [3, 7, 14, 30];

export const TRIAL_WARN_DAYS = 7;
export const TRIAL_URGENT_DAYS = 3;
export const HOME_RECENT_LIMIT = HISTORY_RECENT_DEFAULT;
export const HOME_AI_ACTIVITY_LIMIT = 5;
export const AI_ACTIVITY_POLL_MS = 30_000;
export const QUICK_SEARCH_LIMIT = 8;
export const PASSWORD_AGE_LIST_LIMIT = 10;
export const OPEN_ALL_CONFIRM_THRESHOLD = 5;
export const CHECK_ALL_LIMIT = 50;

// ---------- Renderer only: Needs attention ----------

export type AttentionKind =
  | 'sync-review'
  | 'sync-paused'
  | 'sync-error'
  | 'team-sync-error'
  | 'local-backup-failed'
  | 'local-backup-stale'
  | 'cloud-backup-failed'
  | 'cloud-backup-stale'
  | 'password-age'
  | 'connection-limit'
  | 'device-limit'
  | 'trial-ending';

export type AttentionTone = 'warning' | 'danger';

export type AttentionAction = 'review-sync' | 'open-sync-settings' | 'open-backup-settings' | 'show-passwords' | 'see-plans';

export interface AttentionItem {
  readonly kind: AttentionKind;
  readonly tone: AttentionTone;
  readonly title: string;
  readonly detail: string | null;
  readonly action: AttentionAction | null;
  readonly actionLabel: string | null;
  /** password-age only: the entries, oldest password first. */
  readonly entryIds?: readonly string[];
}
