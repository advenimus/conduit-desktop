import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, FileCodeIcon } from "../../../lib/icons";
interface FileEditBlockProps {
  path: string;
  diff: { before: string; after: string };
}

export default function FileEditBlock({ path, diff }: FileEditBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const filename = path.split("/").pop() ?? path;

  return (
    <div className="my-1.5 rounded-md bg-well border border-stroke text-xs overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left cursor-pointer hover:bg-panel"
      >
        <FileCodeIcon size={14} className="text-amber-400 flex-shrink-0" />
        <span className="text-ink-muted font-mono truncate" title={path}>
          {filename}
        </span>
        <span className="ml-auto text-ink-faint text-[10px] uppercase tracking-wider mr-1">
          edited
        </span>
        {expanded
          ? <ChevronDownIcon size={12} className="text-ink-faint" />
          : <ChevronRightIcon size={12} className="text-ink-faint" />}
      </button>

      {expanded && (
        <div className="border-t border-stroke px-3 py-2 overflow-x-auto">
          <div className="text-[10px] text-ink-faint mb-1 font-mono">{path}</div>
          <pre className="text-[11px] whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
            {diff.after || diff.before || "(no content)"}
          </pre>
        </div>
      )}
    </div>
  );
}
