import { CheckIcon, CloseIcon, ShieldCheckIcon } from "../../../lib/icons";
interface ApprovalCardProps {
  id: string;
  description: string;
  command?: string;
  status: "pending" | "approved" | "denied";
  onRespond?: (approvalId: string, approved: boolean) => void;
}

export default function ApprovalCard({ id, description, command, status, onRespond }: ApprovalCardProps) {
  return (
    <div
      className={`my-1.5 rounded-md border text-xs overflow-hidden ${
        status === "pending"
          ? "bg-amber-500/10 dark:bg-amber-500/15 border-amber-500/30"
          : status === "approved"
            ? "bg-green-500/10 dark:bg-green-500/15 border-green-500/30"
            : "bg-red-500/10 dark:bg-red-500/15 border-red-500/30"
      }`}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <ShieldCheckIcon
          size={14}
          className={`flex-shrink-0 mt-0.5 ${
            status === "pending" ? "text-amber-500" : status === "approved" ? "text-green-500" : "text-red-500"
          }`}
        />
        <div className="flex-1 min-w-0">
          <p className="text-ink text-xs">{description}</p>
          {command && (
            <code className="block mt-1 text-[11px] text-ink-muted font-mono bg-well rounded px-1.5 py-0.5">
              {command}
            </code>
          )}
        </div>
      </div>

      {status === "pending" && onRespond && (
        <div className="flex border-t border-amber-500/20">
          <button
            onClick={() => onRespond(id, true)}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-green-600 dark:text-green-400 hover:bg-green-500/10 transition-colors"
          >
            <CheckIcon size={12} />
            Approve
          </button>
          <div className="w-px bg-amber-500/20" />
          <button
            onClick={() => onRespond(id, false)}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <CloseIcon size={12} />
            Deny
          </button>
        </div>
      )}

      {status !== "pending" && (
        <div
          className={`flex items-center justify-center gap-1.5 px-3 py-1 border-t text-[10px] uppercase tracking-wider ${
            status === "approved"
              ? "border-green-500/20 text-green-600 dark:text-green-400"
              : "border-red-500/20 text-red-600 dark:text-red-400"
          }`}
        >
          {status === "approved" ? <CheckIcon size={10} /> : <CloseIcon size={10} />}
          {status}
        </div>
      )}
    </div>
  );
}
