import { CheckIcon, LockIcon, RefreshIcon, UsersIcon } from "../../lib/icons";
interface ProVaultLockDialogProps {
  lockedByEmail: string;
  lockedAt: string;
  onRetry: () => void;
  onUpgrade: () => void;
  onCancel: () => void;
}

function formatLockTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();

  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return isToday
    ? `${time} today`
    : `${time} on ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/**
 * Shown when someone without the Teams plan opens a team vault that another person has open.
 * Personal vaults use the take-over dialog instead (components/sync/TakeoverDialog).
 */
export default function ProVaultLockDialog({
  lockedByEmail,
  lockedAt,
  onRetry,
  onUpgrade,
  onCancel,
}: ProVaultLockDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-dialog-content className="bg-panel border border-stroke rounded-lg shadow-xl w-[600px] flex overflow-hidden">
        {/* Left: Lock info + actions */}
        <div className="flex-1 p-6">
          {/* Header */}
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <LockIcon size={20} className="text-amber-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-ink">Team Vault In Use</h2>
            </div>
          </div>

          {/* Description */}
          <p className="text-sm text-ink-secondary mb-4">
            Another person has this team vault open. Without the Teams plan, one person can use it at a time.
          </p>

          {/* Lock info */}
          <div className="p-3 rounded-md bg-well border border-stroke mb-5 space-y-1">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-ink-muted">In use by:</span>
              <span className="text-ink font-medium">{lockedByEmail}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-ink-muted">Since:</span>
              <span className="text-ink">{formatLockTime(lockedAt)}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm text-ink-secondary hover:text-ink rounded-md hover:bg-well transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onRetry}
              className="px-4 py-2 text-sm text-ink-secondary hover:text-ink rounded-md hover:bg-well transition-colors flex items-center gap-1.5"
            >
              <RefreshIcon size={14} />
              Try Again
            </button>
          </div>
        </div>

        {/* Right: Upgrade benefits */}
        <div className="w-[220px] bg-well/50 border-l border-stroke-dim p-6 flex flex-col justify-center">
          <span className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-4">
            Teams Plan
          </span>

          <ul className="space-y-2.5 mb-5">
            {["Everyone on the team at once", "Shared team vaults", "Audit log"].map((benefit) => (
              <li key={benefit} className="flex items-center gap-2 text-xs text-ink-secondary">
                <CheckIcon size={12} className="text-conduit-400 flex-shrink-0" />
                {benefit}
              </li>
            ))}
          </ul>

          <button
            onClick={onUpgrade}
            className="w-full px-4 py-2.5 text-sm font-medium bg-conduit-600 text-white rounded-lg hover:bg-conduit-500 transition-colors flex items-center justify-center gap-1.5"
          >
            <UsersIcon size={14} />
            Upgrade to Teams
          </button>
        </div>
      </div>
    </div>
  );
}
