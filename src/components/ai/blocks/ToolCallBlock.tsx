import { useState } from "react";
import {
  AlertTriangleIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, LoaderIcon, ToolIcon
} from "../../../lib/icons";
interface ToolCallBlockProps {
  name: string;
  input?: unknown;
  output?: string;
  status: "running" | "success" | "error";
}

export default function ToolCallBlock({ name, input, output, status }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = input !== undefined || output !== undefined;

  return (
    <div className="my-1.5 rounded-md bg-well border border-stroke text-xs overflow-hidden">
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={`flex items-center gap-2 w-full px-3 py-1.5 text-left ${
          hasDetails ? "cursor-pointer hover:bg-panel" : "cursor-default"
        }`}
      >
        <ToolIcon size={14} className="text-ink-faint flex-shrink-0" />
        <span className="text-ink-muted font-mono truncate">{name}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {status === "running" && <LoaderIcon size={12} className="animate-spin text-conduit-400" />}
          {status === "success" && <CheckIcon size={12} className="text-green-400" />}
          {status === "error" && <AlertTriangleIcon size={12} className="text-red-400" />}
          {hasDetails && (
            expanded
              ? <ChevronDownIcon size={12} className="text-ink-faint" />
              : <ChevronRightIcon size={12} className="text-ink-faint" />
          )}
        </span>
      </button>

      {expanded && hasDetails && (
        <div className="border-t border-stroke px-3 py-2 space-y-2">
          {input !== undefined && (
            <div>
              <span className="text-ink-faint text-[10px] uppercase tracking-wider">Input</span>
              <pre className="mt-0.5 text-[11px] text-ink-muted whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {output !== undefined && (
            <div>
              <span className="text-ink-faint text-[10px] uppercase tracking-wider">Output</span>
              <pre className="mt-0.5 text-[11px] text-ink-muted whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
