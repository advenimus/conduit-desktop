import { useState } from "react";
import { FileCodeIcon } from "../../../lib/icons";
import { BlockBody, BlockChevron, BlockFrame, BlockHeader, BlockLabel } from "./BlockParts";

interface FileEditBlockProps {
  path: string;
  diff: { before: string; after: string };
}

export default function FileEditBlock({ path, diff }: FileEditBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const filename = path.split("/").pop() ?? path;

  return (
    <BlockFrame>
      <BlockHeader onClick={() => setExpanded(!expanded)}>
        <FileCodeIcon size={16} className="shrink-0 text-warning" />
        <span className="truncate font-mono text-ink-muted" title={path}>
          {filename}
        </span>
        <BlockLabel className="ml-auto mr-1 text-ink-faint">Edited</BlockLabel>
        <BlockChevron expanded={expanded} />
      </BlockHeader>

      {expanded && (
        <BlockBody className="overflow-x-auto">
          <div className="mb-1 font-mono text-badge text-ink-faint">{path}</div>
          <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-all text-meta text-ink">
            {diff.after || diff.before || "(no content)"}
          </pre>
        </BlockBody>
      )}
    </BlockFrame>
  );
}
