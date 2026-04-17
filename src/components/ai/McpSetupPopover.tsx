import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "../../lib/electron";
import { toast } from "../common/Toast";
import { useAiStore } from "../../stores/aiStore";
import { useTierStore } from "../../stores/tierStore";
import { MCP_TOOL_COMMANDS } from "./mcpCommands";
import { CheckIcon, CopyIcon, PlugIcon } from "../../lib/icons";

export default function McpSetupPopover() {
  const [open, setOpen] = useState(false);
  const [mcpPath, setMcpPath] = useState<string | null>(null);
  const [socketPath, setSocketPath] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const terminalMode = useAiStore((s) => s.terminalMode);
  const mcpEnabled = useTierStore((s) => s.mcpEnabled);

  useEffect(() => {
    if (open && !mcpPath) {
      invoke<string>("engine_get_mcp_path").then(setMcpPath).catch(() => {});
    }
    if (open && !socketPath) {
      invoke<string>("engine_get_socket_path").then(setSocketPath).catch(() => {});
    }
  }, [open, mcpPath, socketPath]);

  const handleCopy = useCallback(
    async (idx: number, text: string) => {
      await navigator.clipboard.writeText(text);
      toast.success("Command copied");
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 2000);
    },
    []
  );

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  if (!terminalMode || !mcpEnabled) return null;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        className={`flex-shrink-0 p-2 rounded hover:bg-raised ${
          open ? "bg-raised text-conduit-400" : "text-ink-muted"
        }`}
        title="MCP Setup"
      >
        <PlugIcon size={18} />
      </button>

      {open && (
        <div
          ref={popoverRef}
          data-popover
          className="absolute right-0 top-full mt-1 z-50 w-[440px] bg-panel border border-stroke rounded-lg shadow-xl p-4"
        >
          <h3 className="text-sm font-semibold text-ink mb-1">
            Connect AI Tools to Conduit
          </h3>
          <p className="text-xs text-ink-muted mb-3">
            Run one of these commands in your project directory to add
            Conduit's MCP server.
          </p>

          {!mcpPath || !socketPath ? (
            <div className="text-xs text-ink-muted">Loading...</div>
          ) : (
            <div className="space-y-2">
              {MCP_TOOL_COMMANDS.map((tool, idx) => {
                const cmd = tool.command(mcpPath, socketPath);
                return (
                  <div key={tool.label}>
                    <div className="text-xs font-medium text-ink-muted mb-1">
                      {tool.label}
                    </div>
                    <div className="flex items-start gap-2 bg-raised rounded-md p-2 group">
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
      )}
    </div>
  );
}
