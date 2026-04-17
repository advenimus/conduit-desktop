import { useEffect, useState, useCallback } from "react";
import { generateTotpCode, type TotpResult } from "../../lib/totp";
import { useEntryStore } from "../../stores/entryStore";
import { useSessionStore } from "../../stores/sessionStore";
import { getEntryIcon, getEntryColor } from "../entries/entryIcons";
import { toast } from "../common/Toast";
import { invoke } from "../../lib/electron";
import MarkdownRenderer from "../markdown/MarkdownRenderer";
import PasswordHistoryDialog from "../vault/PasswordHistoryDialog";
import type { EntryFull, ResolvedCredential } from "../../types/entry";
import {
  CalendarIcon, ClockIcon, CopyIcon, ExternalLinkIcon, EyeIcon, EyeOffIcon, GlobeIcon, HistoryIcon, KeyIcon, LockIcon, NotesIcon, PencilIcon, ServerIcon, ShieldLockIcon, StarFilledIcon, StarIcon, TagIcon, UserIcon
} from "../../lib/icons";

interface EntryDashboardProps {
  entryId: string;
}

function IconButton({
  icon,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1.5 rounded hover:bg-raised text-ink-muted hover:text-ink transition-colors"
    >
      {icon}
    </button>
  );
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  const formatted = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  if (diffDays === 0) return `${formatted} (today)`;
  if (diffDays === 1) return `${formatted} (yesterday)`;
  if (diffDays < 7) return `${formatted} (${diffDays}d ago)`;
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${formatted} (${weeks}w ago)`;
  }
  if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return `${formatted} (${months}mo ago)`;
  }
  const years = Math.floor(diffDays / 365);
  return `${formatted} (${years}y ago)`;
}

export default function EntryDashboard({ entryId }: EntryDashboardProps) {
  const { entries, openEntry, updateEntry, getEntry, resolveCredential } = useEntryStore();
  const entry = entries.find((e) => e.id === entryId);

  const [fullEntry, setFullEntry] = useState<EntryFull | null>(null);
  const [credential, setCredential] = useState<ResolvedCredential | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordHistory, setShowPasswordHistory] = useState(false);
  const [totpResult, setTotpResult] = useState<TotpResult | null>(null);

  useEffect(() => {
    if (!entry) return;
    // Load full entry details
    getEntry(entryId).then(setFullEntry).catch(() => setFullEntry(null));
    // Resolve credential if it's a connection type (not credential or document)
    if (entry.entry_type !== "credential" && entry.entry_type !== "document") {
      resolveCredential(entryId).then(setCredential).catch(() => setCredential(null));
    } else {
      setCredential(null);
    }
  }, [entryId, entry, getEntry, resolveCredential]);

  // TOTP code generation with 1s interval
  const totpSecret = fullEntry?.totp_secret ?? null;
  const totpConfig = fullEntry?.config as Record<string, unknown> | undefined;
  const totpAlgorithm = (totpConfig?.totp_algorithm as string) ?? undefined;
  const totpDigits = (totpConfig?.totp_digits as number) ?? undefined;
  const totpPeriod = (totpConfig?.totp_period as number) ?? undefined;
  const totpIssuer = (totpConfig?.totp_issuer as string) ?? null;
  const totpLabel = (totpConfig?.totp_label as string) ?? null;

  const updateTotp = useCallback(() => {
    if (!totpSecret) {
      setTotpResult(null);
      return;
    }
    try {
      const result = generateTotpCode({
        secret: totpSecret,
        algorithm: totpAlgorithm,
        digits: totpDigits,
        period: totpPeriod,
      });
      setTotpResult(result);
    } catch {
      setTotpResult(null);
    }
  }, [totpSecret, totpAlgorithm, totpDigits, totpPeriod]);

  useEffect(() => {
    updateTotp();
    if (!totpSecret) return;
    const interval = setInterval(updateTotp, 1000);
    return () => clearInterval(interval);
  }, [totpSecret, updateTotp]);

  if (!entry) {
    return (
      <div className="flex-1 flex items-center justify-center bg-canvas">
        <p className="text-ink-faint">Entry not found</p>
      </div>
    );
  }

  const Icon = getEntryIcon(entry.entry_type, false, entry.icon);
  const colorResult = getEntryColor(entry.entry_type, entry.color);

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Failed to copy ${label}`);
    }
  };

  const handleToggleFavorite = () => {
    updateEntry(entryId, { is_favorite: !entry.is_favorite });
  };

  const handleOpen = () => {
    if (entry.entry_type !== "credential") {
      // If viewing from a dashboard tab, close it first so the new session replaces it
      const dashboardSessionId = `dashboard::${entryId}`;
      const { sessions, closeSession } = useSessionStore.getState();
      if (sessions.some((s) => s.id === dashboardSessionId)) {
        closeSession(dashboardSessionId);
      }
      openEntry(entryId);
    }
  };

  const handleOpenExternal = async () => {
    try {
      await invoke("entry_open_external", { id: entryId });
      toast.success("Opened in external app");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open externally");
    }
  };

  const handleEdit = () => {
    document.dispatchEvent(new CustomEvent("conduit:edit-entry", { detail: entryId }));
  };

  const isConnectionType = ["ssh", "rdp", "vnc", "web"].includes(entry.entry_type);

  // Determine displayed username/password
  const displayUsername = credential?.username ?? entry.username;
  const displayPassword = fullEntry?.password ?? credential?.password ?? null;

  return (
    <>
    <div className="flex-1 flex flex-col bg-canvas overflow-hidden">
      {/* Header */}
      <div className="px-6 py-5 border-b border-stroke flex-shrink-0">
        <div className="flex items-center gap-4">
          <div className="bg-well p-2.5 rounded-lg">
            <Icon size={24} className={colorResult.className} style={colorResult.style} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-ink truncate">{entry.name}</h2>
            <p className="text-xs text-ink-muted capitalize">{entry.entry_type}</p>
          </div>
          <div className="flex items-center gap-1">
            <IconButton
              icon={
                entry.is_favorite ? (
                  <StarFilledIcon size={18} className="text-yellow-400" />
                ) : (
                  <StarIcon size={18} />
                )
              }
              title={entry.is_favorite ? "Remove from favorites" : "Add to favorites"}
              onClick={handleToggleFavorite}
            />
            <IconButton
              icon={<PencilIcon size={18} />}
              title="Edit entry"
              onClick={handleEdit}
            />
            {isConnectionType && (
              <IconButton
                icon={<ExternalLinkIcon size={18} />}
                title="Open in external app"
                onClick={handleOpenExternal}
              />
            )}
          </div>
          {entry.entry_type !== "credential" && (
            <button
              onClick={handleOpen}
              className="px-4 py-2 bg-conduit-600 hover:bg-conduit-700 text-white rounded-md text-sm font-medium transition-colors"
            >
              {entry.entry_type === "document" ? "Open Document" : "Open Session"}
            </button>
          )}
        </div>
      </div>

      {/* Content area — two columns when notes exist */}
      <div className={`flex-1 min-h-0 flex ${entry.notes ? "" : "flex-col"}`}>
        {/* Left: Details */}
        <div className={`overflow-y-auto px-6 py-5 ${entry.notes ? "w-2/5 flex-shrink-0 border-r border-stroke" : `flex-1 ${entry.entry_type !== "document" ? "max-w-2xl" : ""}`}`}>
          {/* Document preview */}
          {entry.entry_type === "document" && (
            <div className="mb-4">
              {(() => {
                const docContent = (entry.config as { content?: string })?.content ?? "";
                if (docContent.trim()) {
                  return (
                    <div className="max-h-40 overflow-hidden relative">
                      <MarkdownRenderer content={docContent.slice(0, 500)} />
                      {docContent.length > 500 && (
                        <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-canvas to-transparent" />
                      )}
                    </div>
                  );
                }
                return <p className="text-sm text-ink-faint italic">Empty document</p>;
              })()}
            </div>
          )}

          {/* Connection details (non-document) */}
          <div className="space-y-0">
            {entry.entry_type !== "document" && entry.host && (
              <DetailRow
                label="Host"
                icon={<ServerIcon size={16} />}
                value={`${entry.host}${entry.port ? `:${entry.port}` : ""}`}
                actions={
                  <IconButton
                    icon={<CopyIcon size={14} />}
                    title="Copy host"
                    onClick={() => copyToClipboard(entry.host!, "Host")}
                  />
                }
              />
            )}
            {entry.entry_type !== "document" && displayUsername && (
              <DetailRow
                label="Username"
                icon={<UserIcon size={16} />}
                value={displayUsername}
                actions={
                  <IconButton
                    icon={<CopyIcon size={14} />}
                    title="Copy username"
                    onClick={() => copyToClipboard(displayUsername, "Username")}
                  />
                }
              />
            )}
            {entry.entry_type !== "document" && displayPassword && (
              <DetailRow
                label="Password"
                icon={<LockIcon size={16} />}
                value={
                  <span className="font-mono">
                    {showPassword ? displayPassword : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}
                  </span>
                }
                actions={
                  <div className="flex items-center gap-0.5">
                    <IconButton
                      icon={
                        showPassword ? (
                          <EyeOffIcon size={14} />
                        ) : (
                          <EyeIcon size={14} />
                        )
                      }
                      title={showPassword ? "Hide password" : "Reveal password"}
                      onClick={() => setShowPassword(!showPassword)}
                    />
                    <IconButton
                      icon={<CopyIcon size={14} />}
                      title="Copy password"
                      onClick={() => copyToClipboard(displayPassword, "Password")}
                    />
                    <IconButton
                      icon={<HistoryIcon size={14} />}
                      title="Password history"
                      onClick={() => setShowPasswordHistory(true)}
                    />
                  </div>
                }
              />
            )}
            {totpResult && (
              <DetailRow
                label="One-Time Password"
                icon={<ShieldLockIcon size={16} />}
                value={
                  <div className="flex items-center gap-2">
                    <span className="font-mono tracking-widest">
                      {totpResult.code.slice(0, Math.ceil(totpResult.code.length / 2))}
                      {" "}
                      {totpResult.code.slice(Math.ceil(totpResult.code.length / 2))}
                    </span>
                    <TotpCountdown remaining={totpResult.remainingSeconds} period={totpResult.period} />
                    {totpIssuer && (
                      <span className="text-xs text-ink-faint">
                        {totpIssuer}{totpLabel ? ` (${totpLabel})` : ""}
                      </span>
                    )}
                  </div>
                }
                actions={
                  <IconButton
                    icon={<CopyIcon size={14} />}
                    title="Copy code"
                    onClick={() => copyToClipboard(totpResult.code, "TOTP code")}
                  />
                }
              />
            )}
            {entry.entry_type !== "document" && entry.domain && (
              <DetailRow label="Domain" icon={<GlobeIcon size={16} />} value={entry.domain} />
            )}
            {entry.entry_type !== "document" && credential && credential.source !== "inline" && (
              <DetailRow
                label="Credential"
                icon={<KeyIcon size={16} />}
                value={`${credential.source}${credential.source_entry_id ? " (entry)" : credential.source_folder_id ? " (folder)" : ""}`}
              />
            )}
            {entry.tags.length > 0 && (
              <div className="py-3 border-b border-stroke-dim">
                <span className="text-[11px] font-medium text-conduit-500 uppercase tracking-wide">
                  Tags
                </span>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {entry.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-well border border-stroke rounded-full text-xs text-ink-secondary"
                    >
                      <TagIcon size={11} className="text-ink-faint" />
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <DetailRow label="Created" icon={<CalendarIcon size={16} />} value={formatRelativeDate(entry.created_at)} />
            <DetailRow label="Modified" icon={<ClockIcon size={16} />} value={formatRelativeDate(entry.updated_at)} last />
          </div>
        </div>

        {/* Right: Notes (only when notes exist) */}
        {entry.notes && (
          <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5 allow-select">
            <div className="flex items-center gap-2 mb-4">
              <NotesIcon size={16} className="text-conduit-500" />
              <span className="text-[11px] font-medium text-conduit-500 uppercase tracking-wide">
                Notes
              </span>
              <div className="flex-1 border-b border-stroke-dim" />
            </div>
            <MarkdownRenderer content={entry.notes} />
          </div>
        )}
      </div>
    </div>
    {showPasswordHistory && (
      <PasswordHistoryDialog
        entryId={entryId}
        entryName={entry.name}
        onClose={() => setShowPasswordHistory(false)}
      />
    )}
    </>
  );
}

function TotpCountdown({ remaining, period }: { remaining: number; period: number }) {
  const size = 14;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = remaining / period;
  const dashOffset = circumference * (1 - fraction);
  const isLow = remaining <= 5;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="flex-shrink-0">
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke="currentColor" strokeWidth={strokeWidth}
        className="text-stroke"
      />
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        className={`transition-all duration-1000 linear ${isLow ? "text-red-400" : "text-conduit-500"}`}
        stroke="currentColor"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function DetailRow({
  label,
  value,
  icon,
  actions,
  last,
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`py-3 flex items-center gap-3 ${last ? "" : "border-b border-stroke-dim"}`}>
      {icon && (
        <div className="flex-shrink-0 text-ink-faint mt-0.5">
          {icon}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-medium text-conduit-500 uppercase tracking-wide">
          {label}
        </div>
        <div className="text-sm text-ink mt-0.5 allow-select">{value}</div>
      </div>
      {actions && (
        <div className="flex-shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
