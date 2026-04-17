import type { MessageBlock } from "../../../stores/aiStore";
import TextBlock from "./TextBlock";
import ToolCallBlock from "./ToolCallBlock";
import FileEditBlock from "./FileEditBlock";
import FileCreateBlock from "./FileCreateBlock";
import CommandBlock from "./CommandBlock";
import ApprovalCard from "./ApprovalCard";
import { AlertTriangleIcon, FileXIcon } from "../../../lib/icons";
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
              <div key={i} className="flex items-center gap-2 my-1.5 px-3 py-1.5 rounded-md bg-well border border-red-700/40 text-xs">
                <FileXIcon size={14} className="text-red-400 flex-shrink-0" />
                <span className="text-ink-muted font-mono truncate">{block.path}</span>
                <span className="ml-auto text-red-400/70 text-[10px] uppercase tracking-wider">deleted</span>
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
              <div key={i} className="flex items-start gap-2 my-1.5 px-3 py-2 rounded-md bg-red-900/30 border border-red-700/50 text-xs">
                <AlertTriangleIcon size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
                <span className="text-red-300">{block.message}</span>
              </div>
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
