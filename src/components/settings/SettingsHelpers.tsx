import { CheckIcon, AlertTriangleIcon } from "../../lib/icons";
import { EmptyState } from "../ui";
import type { RdpGlobalDefaults, WebGlobalDefaults, TerminalGlobalDefaults, SshGlobalDefaults } from "../../types/entry";
import { HARDCODED_RDP_DEFAULTS, HARDCODED_WEB_DEFAULTS, HARDCODED_TERMINAL_DEFAULTS, HARDCODED_SSH_DEFAULTS } from "../../types/entry";
import type { EngineType } from "../../lib/ai-harnesses";

export interface Settings {
  theme: string;
  color_scheme: string;
  icon_pack: string;
  default_shell: string;
  ai_mode: "api" | "cli";
  cli_agent: "claude" | "codex";
  cli_font_size: number;
  default_engine: EngineType;
  default_working_directory: string | null;
  ui_scale: number;
  default_web_engine: "auto" | "chromium" | "webview2";
  session_defaults_rdp: RdpGlobalDefaults;
  session_defaults_web: WebGlobalDefaults;
  session_defaults_terminal: TerminalGlobalDefaults;
  session_defaults_ssh: SshGlobalDefaults;
  /** Multi-device sync (on by default). No UI; support can turn it off through sync_set_enabled. */
  personal_sync_enabled: boolean;
  /** Idle auto-lock in minutes; 0 = off (the default). */
  vault_idle_lock_minutes: number;
}

export { HARDCODED_RDP_DEFAULTS, HARDCODED_WEB_DEFAULTS, HARDCODED_TERMINAL_DEFAULTS, HARDCODED_SSH_DEFAULTS };

export type SettingsTab =
  | "general"
  | "appearance"
  | "security"
  | "sessions/terminal"
  | "sessions/ssh"
  | "sessions/rdp"
  | "sessions/vnc"
  | "sessions/web"
  | "ai"
  | "ai/agent"
  | "backup"
  | "sync"
  | "mobile"
  | "team"
  | "account";

export interface TabProps {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  onClose: () => void;
}

export interface UsageData {
  usage: {
    total_used: number;
    request_count: number;
    monthly_limit: number;
    monthly_remaining: number;
    monthly_resets_at: string;
    daily_used: number;
    daily_limit: number;
    daily_remaining: number;
    daily_resets_at: string;
  };
  tier: { name: string; display_name: string };
  is_team_member: boolean;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function EngineStatusRow({ label, available, description }: { label: string; available: boolean; description: string }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className={`size-2 shrink-0 rounded-full ${available ? "bg-success" : "bg-ink-faint"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-label font-semibold text-ink">{label}</span>
          {available
            ? <CheckIcon size={12} className="text-success" />
            : <AlertTriangleIcon size={12} className="text-ink-faint" />}
        </div>
        <p className="truncate text-meta text-ink-muted">{description}</p>
      </div>
    </div>
  );
}

function usageTone(isExhausted: boolean, isWarning: boolean): { bar: string; text: string } {
  if (isExhausted) return { bar: "bg-danger", text: "text-danger" };
  if (isWarning) return { bar: "bg-warning", text: "text-warning" };
  return { bar: "bg-accent", text: "text-ink-muted" };
}

export function UsageBar({ used, limit, label, resetsAt }: {
  used: number;
  limit: number;
  label: string;
  resetsAt?: string;
}) {
  const isUnlimited = limit === -1;
  const percentage = isUnlimited ? 0 : Math.min(100, (used / limit) * 100);
  const isWarning = !isUnlimited && percentage >= 80;
  const isExhausted = !isUnlimited && percentage >= 100;
  const tone = usageTone(isExhausted, isWarning);

  const resetsLabel = resetsAt
    ? new Date(resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-label font-semibold text-ink-secondary">{label}</span>
        <span className="text-label text-ink-muted">
          {isUnlimited
            ? `${formatTokens(used)} used (unlimited)`
            : `${formatTokens(used)} / ${formatTokens(limit)}`}
        </span>
      </div>
      {!isUnlimited && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-selected">
          <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${percentage}%` }} />
        </div>
      )}
      <div className="mt-0.5 flex items-center justify-between">
        {!isUnlimited && (
          <span className={`text-meta ${tone.text}`}>
            {isExhausted ? "Limit reached" : `${formatTokens(limit - used)} remaining`}
          </span>
        )}
        {resetsLabel && !isUnlimited && (
          <span className="text-meta text-ink-muted">Resets {resetsLabel}</span>
        )}
      </div>
    </div>
  );
}

export function SessionEmptyState({ type }: { type: string }) {
  return (
    <EmptyState
      className="py-12"
      title={`No ${type} settings yet`}
      description={`Session-specific settings for ${type} connections will appear here.`}
    />
  );
}
