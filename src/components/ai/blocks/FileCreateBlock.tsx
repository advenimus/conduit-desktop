import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, FilePlusIcon } from "../../../lib/icons";
interface FileCreateBlockProps {
  path: string;
  content: string;
}

export default function FileCreateBlock({ path, content }: FileCreateBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const filename = path.split("/").pop() ?? path;

  return (
    <div className="my-1.5 rounded-md bg-well border border-green-700/40 text-xs overflow-hidden">
      <button
        onClick={() => content && setExpanded(!expanded)}
        className={`flex items-center gap-2 w-full px-3 py-1.5 text-left ${
          content ? "cursor-pointer hover:bg-panel" : "cursor-default"
        }`}
      >
        <FilePlusIcon size={14} className="text-green-400 flex-shrink-0" />
        <span className="text-ink-muted font-mono truncate" title={path}>
          {filename}
        </span>
        <span className="ml-auto text-green-400/70 text-[10px] uppercase tracking-wider mr-1">
          created
        </span>
        {content && (
          expanded
            ? <ChevronDownIcon size={12} className="text-ink-faint" />
            : <ChevronRightIcon size={12} className="text-ink-faint" />
        )}
      </button>

      {expanded && content && (
        <div className="border-t border-stroke px-3 py-2 overflow-x-auto">
          <div className="text-[10px] text-ink-faint mb-1 font-mono">{path}</div>
          <pre className="text-[11px] text-ink-muted whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}
