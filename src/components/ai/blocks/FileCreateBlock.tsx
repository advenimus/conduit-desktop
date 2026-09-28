import { useState } from "react";
import { FilePlusIcon } from "../../../lib/icons";
import { BlockBody, BlockChevron, BlockFrame, BlockHeader, BlockLabel } from "./BlockParts";

interface FileCreateBlockProps {
  path: string;
  content: string;
}

export default function FileCreateBlock({ path, content }: FileCreateBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const filename = path.split("/").pop() ?? path;

  return (
    <BlockFrame tone="success">
      <BlockHeader onClick={content ? () => setExpanded(!expanded) : undefined}>
        <FilePlusIcon size={16} className="shrink-0 text-success" />
        <span className="truncate font-mono text-ink-muted" title={path}>
          {filename}
        </span>
        <BlockLabel className="ml-auto mr-1 text-success">Created</BlockLabel>
        {content && <BlockChevron expanded={expanded} />}
      </BlockHeader>

      {expanded && content && (
        <BlockBody className="overflow-x-auto">
          <div className="mb-1 font-mono text-badge text-ink-faint">{path}</div>
          <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-all text-meta text-ink-muted">{content}</pre>
        </BlockBody>
      )}
    </BlockFrame>
  );
}
