import { useState } from "react";
import { TerminalIcon } from "../../../lib/icons";
import { BlockBody, BlockChevron, BlockFrame, BlockHeader, StatusGlyph } from "./BlockParts";

interface CommandBlockProps {
  command: string;
  output: string;
  exitCode?: number;
  status: "running" | "success" | "error";
}

export default function CommandBlock({ command, output, exitCode, status }: CommandBlockProps) {
  const [expanded, setExpanded] = useState(status === "running");

  return (
    <BlockFrame>
      <BlockHeader onClick={() => setExpanded(!expanded)}>
        <TerminalIcon size={16} className="shrink-0 text-link" />
        <span className="truncate font-mono text-ink">{command}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {exitCode !== undefined && (
            <span className={`text-badge ${exitCode === 0 ? "text-success" : "text-danger"}`}>exit {exitCode}</span>
          )}
          <StatusGlyph status={status} />
          <BlockChevron expanded={expanded} />
        </span>
      </BlockHeader>

      {expanded && output && (
        <BlockBody>
          <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-all font-mono text-meta text-ink-muted">{output}</pre>
        </BlockBody>
      )}
    </BlockFrame>
  );
}
