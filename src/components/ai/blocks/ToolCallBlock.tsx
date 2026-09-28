import { useState } from "react";
import { ToolIcon } from "../../../lib/icons";
import { BlockBody, BlockChevron, BlockFrame, BlockHeader, BlockLabel, StatusGlyph } from "./BlockParts";

interface ToolCallBlockProps {
  name: string;
  input?: unknown;
  output?: string;
  status: "running" | "success" | "error";
}

const DETAIL = "mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-all text-meta text-ink-muted";

export default function ToolCallBlock({ name, input, output, status }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = input !== undefined || output !== undefined;

  return (
    <BlockFrame>
      <BlockHeader onClick={hasDetails ? () => setExpanded(!expanded) : undefined}>
        <ToolIcon size={16} className="shrink-0 text-ink-faint" />
        <span className="truncate font-mono text-ink-muted">{name}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <StatusGlyph status={status} />
          {hasDetails && <BlockChevron expanded={expanded} />}
        </span>
      </BlockHeader>

      {expanded && hasDetails && (
        <BlockBody className="space-y-2">
          {input !== undefined && (
            <div>
              <BlockLabel>Input</BlockLabel>
              <pre className={DETAIL}>{typeof input === "string" ? input : JSON.stringify(input, null, 2)}</pre>
            </div>
          )}
          {output !== undefined && (
            <div>
              <BlockLabel>Output</BlockLabel>
              <pre className={DETAIL}>{output}</pre>
            </div>
          )}
        </BlockBody>
      )}
    </BlockFrame>
  );
}
