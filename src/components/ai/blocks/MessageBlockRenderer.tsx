import type { MessageBlock } from "../../../stores/aiStore";
import TextBlock from "./TextBlock";
import ToolCallBlock from "./ToolCallBlock";
import FileEditBlock from "./FileEditBlock";
import FileCreateBlock from "./FileCreateBlock";
import CommandBlock from "./CommandBlock";
import ApprovalCard from "./ApprovalCard";
import { FileXIcon } from "../../../lib/icons";
import { Callout } from "../../ui";
import { BlockLabel } from "./BlockParts";
interface MessageBlockRendererProps {
  blocks: MessageBlock[];
  onApprovalRespond?: (approvalId: string, approved: boolean) => void;
}

export default function MessageBlockRenderer({ blocks, onApprovalRespond }: MessageBlockRendererProps) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "text":
            return <TextBlock key={i} content={block.content} />;

          case "tool_call":
            return (
              <ToolCallBlock
                key={block.id}
                name={block.name}
                input={block.input}
                output={block.output}
                status={block.status}
              />
            );

          case "file_edit":
            return <FileEditBlock key={i} path={block.path} diff={block.diff} />;

          case "file_create":
            return <FileCreateBlock key={i} path={block.path} content={block.content} />;

          case "file_delete":
            return (
              <div key={i} className="my-1.5 flex items-center gap-2 rounded-md border border-danger-border bg-well px-3 py-1.5 text-label">
                <FileXIcon size={16} className="shrink-0 text-danger" />
                <span className="truncate font-mono text-ink-muted">{block.path}</span>
                <BlockLabel className="ml-auto text-danger">Deleted</BlockLabel>
              </div>
            );

          case "command":
            return (
              <CommandBlock
                key={block.id}
                command={block.command}
                output={block.output}
                exitCode={block.exitCode}
                status={block.status}
              />
            );

          case "approval":
            return (
              <ApprovalCard
                key={block.id}
                id={block.id}
                description={block.description}
                command={block.command}
                status={block.status}
                onRespond={onApprovalRespond}
              />
            );

          case "error":
            return (
              <Callout key={i} tone="danger" size="sm" icon="alertTriangle" className="my-1.5">
                {block.message}
              </Callout>
            );

          case "system":
            return <TextBlock key={i} content={block.content} />;

          default:
            return null;
        }
      })}
    </>
  );
}
