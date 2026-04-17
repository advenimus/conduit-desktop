import { useState, useEffect, useCallback } from "react";
import { invoke } from "../../lib/electron";
import { toast } from "../common/Toast";
import { MCP_TOOL_COMMANDS } from "./mcpCommands";
import { CheckIcon, CloseIcon, CopyIcon } from "../../lib/icons";

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
    await navigator.clipboard.writeText(text);
    toast.success("Command copied");
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-[60]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={handleKeyDown}
    >
      <div data-dialog-content className="w-full max-w-md bg-panel border border-stroke rounded-lg shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-stroke">
          <h3 className="text-sm font-semibold text-ink">Register MCP Tools</h3>
          <button onClick={onClose} className="p-1 hover:bg-raised rounded">
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-xs text-ink-muted">
            In terminal mode, CLI agents need Conduit's MCP server registered manually.
            Run one of these commands in your project directory:
          </p>

          {!mcpPath || !socketPath ? (
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-conduit-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-ink-muted">Loading MCP path...</span>
            </div>
          ) : (
            <div className="space-y-2">
              {MCP_TOOL_COMMANDS.map((tool, idx) => {
                const cmd = tool.command(mcpPath, socketPath);
                return (
                  <div key={tool.label}>
                    <div className="text-xs font-medium text-ink-muted mb-1">
                      {tool.label}
                    </div>
                    <div className="flex items-start gap-2 bg-raised rounded-md p-2">
                      <code className="flex-1 text-xs text-ink break-all select-all font-mono leading-relaxed">
                        {cmd}
                      </code>
                      <button
                        onClick={() => handleCopy(idx, cmd)}
                        className="flex-shrink-0 p-1 rounded hover:bg-panel text-ink-muted hover:text-ink transition-colors"
                        title="Copy command"
                      >
                        {copiedIdx === idx ? (
                          <CheckIcon size={14} className="text-green-400" />
                        ) : (
                          <CopyIcon size={14} />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex justify-end px-4 py-3 border-t border-stroke">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-white bg-conduit-600 hover:bg-conduit-700 rounded"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
