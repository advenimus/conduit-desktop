import { useState, useEffect } from "react";
import { invoke } from "../../../lib/electron";
import { useAiStore } from "../../../stores/aiStore";
import McpSetupDialog from "../../ai/McpSetupDialog";
import { EngineStatusRow } from "../SettingsHelpers";
import type { TabProps } from "../SettingsHelpers";
import { FolderIcon } from "../../../lib/icons";

export default function AiTab({ settings, setSettings }: TabProps) {
  const tierCapabilities = useAiStore((s) => s.tierCapabilities);
  const engineAvailability = useAiStore((s) => s.engineAvailability);
  const checkEngineAvailability = useAiStore((s) => s.checkEngineAvailability);
  const mcpEnabled = tierCapabilities?.mcp_enabled ?? false;
  const mcpDailyQuota = tierCapabilities?.mcp_daily_quota ?? 50;
  const [showMcpSetup, setShowMcpSetup] = useState(false);

  useEffect(() => {
    checkEngineAvailability();
  }, [checkEngineAvailability]);

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Default Engine</label>
        <select
          value={settings.default_engine}
          onChange={(e) =>
            setSettings({
              ...settings,
              default_engine: e.target.value as "claude-code" | "codex",
            })
          }
          className="w-full px-3 py-2 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
        >
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <p className="text-xs text-ink-muted mt-1">
          Engine selected by default when opening the AI panel. You can switch anytime in the chat header.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Default Working Directory</label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={settings.default_working_directory ?? ""}
            onChange={(e) =>
              setSettings({
                ...settings,
                default_working_directory: e.target.value || null,
              })
            }
            placeholder="Leave empty for home directory"
            className="flex-1 px-3 py-2 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500 text-sm"
          />
          <button
            onClick={async () => {
              const folder = await invoke<string | null>("dialog_select_folder");
              if (folder) {
                setSettings({ ...settings, default_working_directory: folder });
              }
            }}
            className="px-3 py-2 bg-raised hover:bg-well rounded"
            title="Browse"
          >
            <FolderIcon size={16} />
          </button>
        </div>
        <p className="text-xs text-ink-muted mt-1">
          Starting directory for Claude Code and Codex agent sessions.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Terminal Mode</label>
          <p className="text-xs text-ink-muted mt-0.5">
            Launch Claude Code and Codex as CLI terminals instead of the rich chat interface.
          </p>
        </div>
        <button
          onClick={() => {
            const newValue = !settings.terminal_mode;
            setSettings({ ...settings, terminal_mode: newValue });
            if (newValue) setShowMcpSetup(true);
          }}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
            settings.terminal_mode ? "bg-conduit-600" : "bg-well"
          }`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            settings.terminal_mode ? "translate-x-6" : "translate-x-1"
          }`} />
        </button>
      </div>

      {settings.terminal_mode && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium">Terminal Font Size</label>
            <span className="text-sm text-ink-muted tabular-nums">{settings.cli_font_size}px</span>
          </div>
          <input
            type="range"
            min={10}
            max={24}
            value={settings.cli_font_size}
            onChange={(e) => {
              const size = parseInt(e.target.value);
              setSettings({ ...settings, cli_font_size: size });
              document.dispatchEvent(new CustomEvent("conduit:terminal-font-size-change", { detail: { fontSize: size } }));
            }}
            className="w-full accent-conduit-500"
          />
          <div className="flex justify-between text-[10px] text-ink-faint mt-1">
            <span>10px</span>
            <span>24px</span>
          </div>
        </div>
      )}

      <div className="pt-3 border-t border-stroke space-y-2">
        <label className="block text-sm font-medium mb-2">Engine Status</label>
        <EngineStatusRow
          label="Claude Code"
          available={engineAvailability?.['claude-code'] ?? false}
          description={
            engineAvailability?.['claude-code']
              ? "Authenticated via claude login"
              : "Run 'claude login' in your terminal to authenticate"
          }
        />
        <EngineStatusRow
          label="Codex"
          available={engineAvailability?.codex ?? false}
          description={
            engineAvailability?.codex
              ? "Authenticated via codex login"
              : "Run 'codex login' in your terminal to authenticate"
          }
        />
      </div>

      {mcpEnabled && (
        <div className="pt-3 border-t border-stroke">
          <label className="block text-sm font-medium mb-1">MCP Daily Quota</label>
          <p className="text-xs text-ink-muted">
            {mcpDailyQuota === -1
              ? "Unlimited MCP tool calls per day."
              : `${mcpDailyQuota} MCP tool calls per day on your current tier.`}
          </p>
          {mcpDailyQuota !== -1 && (
            <p className="text-[10px] text-ink-faint mt-2">
              <button
                onClick={() => invoke('auth_open_pricing')}
                className="underline hover:text-ink-muted"
              >
                Upgrade to Pro for unlimited MCP tool calls.
              </button>
            </p>
          )}
        </div>
      )}

      {showMcpSetup && <McpSetupDialog onClose={() => setShowMcpSetup(false)} />}
    </div>
  );
}
