import { useState } from "react";
import { useToolApprovalStore, type PendingToolApproval } from "../../stores/toolApprovalStore";
import {
  CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, ShieldCheckIcon
} from "../../lib/icons";

const CATEGORY_COLORS: Record<string, string> = {
  read: "bg-blue-500/15 text-blue-600 dark:text-blue-300 border-blue-500/25",
  execute: "bg-orange-500/15 text-orange-600 dark:text-orange-300 border-orange-500/25",
  write: "bg-purple-500/15 text-purple-600 dark:text-purple-300 border-purple-500/25",
  navigate: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 border-cyan-500/25",
  credential: "bg-red-500/15 text-red-600 dark:text-red-300 border-red-500/25",
  connection: "bg-green-500/15 text-green-600 dark:text-green-300 border-green-500/25",
};

function CategoryBadge({ category }: { category: string }) {
  const colors = CATEGORY_COLORS[category] ?? "bg-ink-faint/20 text-ink-muted border-ink-faint/30";
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${colors}`}>
      {category}
    </span>
  );
}

function ApprovalItem({ approval, queueLabel }: { approval: PendingToolApproval; queueLabel?: string }) {
  const respondToApproval = useToolApprovalStore((s) => s.respondToApproval);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [argsExpanded, setArgsExpanded] = useState(false);

  const argEntries = Object.entries(approval.args);
  const isCredentialTool = approval.category === "credential";

  return (
    <div className="my-1.5 rounded-md border text-xs overflow-hidden bg-amber-500/10 dark:bg-amber-500/15 border-amber-500/30">
      {/* Header */}
      <div className="flex items-start gap-2 px-3 py-2">
        <ShieldCheckIcon size={14} className="flex-shrink-0 mt-0.5 text-amber-500" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-medium text-ink text-xs">{approval.tool_name}</span>
            <CategoryBadge category={approval.category} />
            {queueLabel && (
              <span className="text-[10px] text-ink-faint ml-auto">{queueLabel}</span>
            )}
          </div>
          <p className="text-ink-muted text-[11px] mt-0.5">{approval.description}</p>

          {/* Collapsible args */}
          {argEntries.length > 0 && (
            <div className="mt-1.5">
              <button
                onClick={() => setArgsExpanded(!argsExpanded)}
                className="flex items-center gap-1 text-[10px] font-medium text-ink-faint hover:text-ink-muted transition-colors"
              >
                {argsExpanded
                  ? <ChevronDownIcon size={12} />
                  : <ChevronRightIcon size={12} />
                }
                Arguments ({argEntries.length})
              </button>
              {argsExpanded && (
                <pre className="mt-1 bg-well rounded p-2 text-[10px] text-ink-muted overflow-auto max-h-28 font-mono">
                  {JSON.stringify(approval.args, null, 2)}
                </pre>
              )}
            </div>
          )}

          {/* Credential warning */}
          {isCredentialTool && (
            <div className="mt-1.5 bg-red-500/10 dark:bg-red-500/15 border border-red-500/25 rounded px-2 py-1.5">
              <p className="text-red-600 dark:text-red-300 text-[10px]">
                This will allow the AI to access secrets stored in this credential.
              </p>
            </div>
          )}

          {/* Always allow checkbox */}
          <label className="flex items-center gap-1.5 mt-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => setAlwaysAllow(e.target.checked)}
              className="w-3 h-3 rounded border-stroke accent-conduit-600"
            />
            <span className="text-[10px] text-ink-faint">
              Always allow &ldquo;{approval.tool_name}&rdquo;
            </span>
          </label>
        </div>
      </div>

      {/* Actions */}
      <div className="flex border-t border-amber-500/20">
        <button
          onClick={() => respondToApproval(approval.request_id, true, alwaysAllow)}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-green-600 dark:text-green-400 hover:bg-green-500/10 transition-colors"
        >
          <CheckIcon size={12} />
          Approve
        </button>
        <div className="w-px bg-amber-500/20" />
        <button
          onClick={() => respondToApproval(approval.request_id, false, false)}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
        >
          <CloseIcon size={12} />
          Deny
        </button>
      </div>
    </div>
  );
}

export default function ToolApprovalCard() {
  const pendingApprovals = useToolApprovalStore((s) => s.pendingApprovals);

  if (pendingApprovals.length === 0) return null;

  return (
    <>
      {pendingApprovals.map((approval, index) => (
        <div key={approval.request_id} className="flex gap-3 justify-start">
          <div className="w-8 h-8 rounded-full bg-amber-500 flex items-center justify-center flex-shrink-0">
            <ShieldCheckIcon size={16} className="text-white" />
          </div>
          <div className="max-w-[85%] w-full">
            <ApprovalItem
              approval={approval}
              queueLabel={pendingApprovals.length > 1 ? `${index + 1} of ${pendingApprovals.length}` : undefined}
            />
          </div>
        </div>
      ))}
    </>
  );
}
