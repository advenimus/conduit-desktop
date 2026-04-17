import { CheckIcon, AlertTriangleIcon } from "../../lib/icons";
import type { RdpGlobalDefaults, WebGlobalDefaults, TerminalGlobalDefaults, SshGlobalDefaults } from "../../types/entry";
import { HARDCODED_RDP_DEFAULTS, HARDCODED_WEB_DEFAULTS, HARDCODED_TERMINAL_DEFAULTS, HARDCODED_SSH_DEFAULTS } from "../../types/entry";

export interface Settings {
  theme: string;
  color_scheme: string;
  platform_theme: string;
  default_shell: string;
  ai_mode: "api" | "cli";
  cli_agent: "claude" | "codex";
  cli_font_size: number;
  sidebar_mode: "pinned" | "auto";
  default_engine: "claude-code" | "codex";
  default_working_directory: string | null;
  terminal_mode: boolean;
  ui_scale: number;
  default_web_engine: "auto" | "chromium" | "webview2";
  session_defaults_rdp: RdpGlobalDefaults;
  session_defaults_web: WebGlobalDefaults;
  session_defaults_terminal: TerminalGlobalDefaults;
  session_defaults_ssh: SshGlobalDefaults;
  tool_approval_enabled: boolean;
  tool_approval_always_allow: string[];
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
  | "ai/tools"
  | "backup"
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
      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${available ? "bg-green-400" : "bg-ink-faint"}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink">{label}</span>
          {available
            ? <CheckIcon size={12} className="text-green-400" />
            : <AlertTriangleIcon size={12} className="text-ink-faint" />}
        </div>
        <p className="text-[10px] text-ink-muted truncate">{description}</p>
      </div>
    </div>
  );
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

  let barColor = "bg-conduit-500";
  if (isExhausted) barColor = "bg-red-500";
  else if (isWarning) barColor = "bg-amber-500";

  const resetsLabel = resetsAt
    ? new Date(resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-ink-secondary">{label}</span>
        <span className="text-xs text-ink-muted">
          {isUnlimited
            ? `${formatTokens(used)} used (unlimited)`
            : `${formatTokens(used)} / ${formatTokens(limit)}`}
        </span>
      </div>
      {!isUnlimited && (
        <div className="w-full h-2 bg-well rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}
      <div className="flex items-center justify-between mt-0.5">
        {!isUnlimited && (
          <span className={`text-[10px] ${isExhausted ? "text-red-400" : isWarning ? "text-amber-400" : "text-ink-muted"}`}>
            {isExhausted ? "Limit reached" : `${formatTokens(limit - used)} remaining`}
          </span>
        )}
        {resetsLabel && !isUnlimited && (
          <span className="text-[10px] text-ink-muted">Resets {resetsLabel}</span>
        )}
      </div>
    </div>
  );
}

export function SessionEmptyState({ type }: { type: string }) {
  return (
    <div className="text-center py-12">
      <p className="text-sm text-ink-muted">No {type} settings yet</p>
      <p className="text-xs text-ink-faint mt-1">
        Session-specific settings for {type} connections will appear here.
      </p>
    </div>
  );
}
