import { CheckIcon, CloseIcon, ShieldCheckIcon } from "../../../lib/icons";
import { cx } from "../../ui";

interface ApprovalCardProps {
  id: string;
  description: string;
  command?: string;
  status: "pending" | "approved" | "denied";
  onRespond?: (approvalId: string, approved: boolean) => void;
}

const TONE: Readonly<Record<ApprovalCardProps["status"], { box: string; icon: string }>> = {
  pending: { box: "bg-warning-bg border-warning-border", icon: "text-warning" },
  approved: { box: "bg-success-bg border-success-border", icon: "text-success" },
  denied: { box: "bg-danger-bg border-danger-border", icon: "text-danger" },
};

const STATUS_LABEL = { approved: "Approved", denied: "Denied" } as const;

const CHOICE = "flex flex-1 items-center justify-center gap-1.5 px-3 py-1.5 hover:bg-hover transition-[color,background-color] duration-100";

export default function ApprovalCard({ id, description, command, status, onRespond }: ApprovalCardProps) {
  const tone = TONE[status];
  return (
    <div className={cx("my-1.5 overflow-hidden rounded-md border text-label", tone.box)}>
      <div className="flex items-start gap-2 px-3 py-2">
        <ShieldCheckIcon size={16} className={cx("mt-px shrink-0", tone.icon)} />
        <div className="min-w-0 flex-1">
          <p className="text-ink">{description}</p>
          {command && (
            <code className="mt-1 block rounded bg-code px-1.5 py-0.5 font-mono text-meta text-ink-muted">{command}</code>
          )}
        </div>
      </div>

      {status === "pending" && onRespond && (
        <div className="flex border-t border-warning-border">
          <button type="button" onClick={() => onRespond(id, true)} className={cx(CHOICE, "text-success")}>
            <CheckIcon size={12} compact />
            Approve
          </button>
          <div className="w-px bg-warning-border" />
          <button type="button" onClick={() => onRespond(id, false)} className={cx(CHOICE, "text-danger")}>
            <CloseIcon size={12} compact />
            Deny
          </button>
        </div>
      )}

      {status !== "pending" && (
        <div
          className={cx(
            "flex items-center justify-center gap-1.5 border-t px-3 py-1 text-meta font-semibold",
            status === "approved" ? "border-success-border text-success" : "border-danger-border text-danger",
          )}
        >
          {status === "approved" ? <CheckIcon size={12} compact /> : <CloseIcon size={12} compact />}
          {STATUS_LABEL[status]}
        </div>
      )}
    </div>
  );
}
