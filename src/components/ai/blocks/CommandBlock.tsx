import { useState } from "react";
import {
  AlertTriangleIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, LoaderIcon, TerminalIcon
} from "../../../lib/icons";
interface CommandBlockProps {
  command: string;
  output: string;
  exitCode?: number;
  status: "running" | "success" | "error";
}

export default function CommandBlock({ command, output, exitCode, status }: CommandBlockProps) {
  const [expanded, setExpanded] = useState(status === "running");

  return (
    <div className="my-1.5 rounded-md bg-well border border-stroke text-xs overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left cursor-pointer hover:bg-panel"
      >
        <TerminalIcon size={14} className="text-conduit-300 flex-shrink-0" />
        <span className="text-ink font-mono truncate">{command}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {exitCode !== undefined && (
            <span className={`text-[10px] ${exitCode === 0 ? "text-green-400" : "text-red-400"}`}>
              exit {exitCode}
            </span>
          )}
          {status === "running" && <LoaderIcon size={12} className="animate-spin text-conduit-400" />}
          {status === "success" && <CheckIcon size={12} className="text-green-400" />}
          {status === "error" && <AlertTriangleIcon size={12} className="text-red-400" />}
          {expanded
            ? <ChevronDownIcon size={12} className="text-ink-faint" />
            : <ChevronRightIcon size={12} className="text-ink-faint" />}
        </span>
      </button>

      {expanded && output && (
        <div className="border-t border-stroke px-3 py-2">
          <pre className="text-[11px] text-ink-muted whitespace-pre-wrap break-all max-h-60 overflow-y-auto font-mono">
            {output}
          </pre>
        </div>
      )}
    </div>
  );
}
