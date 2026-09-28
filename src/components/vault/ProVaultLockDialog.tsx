import { CheckIcon } from "../../lib/icons";
import { Button, Dialog, DialogHeader } from "../ui";

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
    <Dialog
      open
      title="Team Vault In Use"
      icon="lock"
      tone="warn"
      width={600}
      hideClose
      closeOnEscape={false}
      onClose={onCancel}
      layout="custom"
    >
      <div className="flex min-h-0">
        <div className="flex-1 min-w-0 pb-4">
          <DialogHeader />
          <div className="px-4 space-y-4 text-body">
            <p className="text-ink-secondary">
              Another person has this team vault open. Without the Teams plan, one person can use it at a time.
            </p>

            <div className="p-3 rounded-md bg-well border border-card-border space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-ink-muted">In use by:</span>
                <span className="text-ink font-medium">{lockedByEmail}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-ink-muted">Since:</span>
                <span className="text-ink">{formatLockTime(lockedAt)}</span>
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={onCancel}>Cancel</Button>
              <Button icon="refresh" onClick={onRetry}>
                Try Again
              </Button>
            </div>
          </div>
        </div>

        <div className="w-[220px] bg-well border-l border-divider p-6 flex flex-col justify-center">
          <span className="text-meta font-semibold text-ink-muted mb-4">Teams Plan</span>

          <ul className="space-y-2.5 mb-5">
            {["Everyone on the team at once", "Shared team vaults", "Audit log"].map((benefit) => (
              <li key={benefit} className="flex items-center gap-2 text-label text-ink-secondary">
                <CheckIcon size={12} className="text-info flex-shrink-0" />
                {benefit}
              </li>
            ))}
          </ul>

          <Button variant="primary" icon="users" fullWidth onClick={onUpgrade}>
            Upgrade to Teams
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
