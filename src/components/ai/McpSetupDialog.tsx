import { useState, useEffect, useCallback } from "react";
import { invoke } from "../../lib/electron";
import { toast } from "../common/Toast";
import { MCP_TOOL_COMMANDS } from "./mcpCommands";
import { Button, Dialog, IconButton, Spinner } from "../ui";

interface McpSetupDialogProps {
  onClose: () => void;
}

export default function McpSetupDialog({ onClose }: McpSetupDialogProps) {
  const [mcpPath, setMcpPath] = useState<string | null>(null);
  const [socketPath, setSocketPath] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  useEffect(() => {
    invoke<string>("engine_get_mcp_path").then(setMcpPath).catch(() => {});
    invoke<string>("engine_get_socket_path").then(setSocketPath).catch(() => {});
  }, []);

  const handleCopy = useCallback(async (idx: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error("Failed to copy the MCP command:", err);
      toast.error("Could not copy the command");
      return;
    }
    toast.success("Command copied");
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  }, []);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Register MCP Tools"
      width={448}
      layer="sync"
      closeOnScrim
      footer={
        <Button variant="primary" onClick={onClose}>
          Got it
        </Button>
      }
    >
      <div className="space-y-3 py-2">
        <p className="text-label text-ink-muted">
          In terminal mode, CLI agents need Conduit's MCP server registered manually.
          Run the command for your agent in your project directory:
        </p>

        {!mcpPath || !socketPath ? (
          <Spinner size={16} text="Loading MCP path..." className="text-label text-ink-muted" />
        ) : (
          <div className="space-y-2">
            {MCP_TOOL_COMMANDS.map((tool, idx) => {
              const cmd = tool.command(mcpPath, socketPath);
              const copied = copiedIdx === idx;
              return (
                <div key={tool.label}>
                  <div className="mb-1 text-label font-semibold text-ink-secondary">{tool.label}</div>
                  <div className="flex items-start gap-2 rounded-md border border-card-border bg-code p-2">
                    <code className="flex-1 select-all break-all font-mono text-label leading-relaxed text-ink">
                      {cmd}
                    </code>
                    <IconButton
                      size="sm"
                      icon={copied ? "check" : "copy"}
                      label="Copy command"
                      tone={copied ? "inherit" : "default"}
                      className={copied ? "text-success" : undefined}
                      onClick={() => handleCopy(idx, cmd)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}
