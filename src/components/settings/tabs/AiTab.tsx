import { useState, useEffect } from "react";
import { invoke } from "../../../lib/electron";
import { useAiStore } from "../../../stores/aiStore";
import McpSetupDialog from "../../ai/McpSetupDialog";
import MCPQuotaCounter from "../../ai/MCPQuotaCounter";
import EngineLogo from "../../ai/EngineLogo";
import { EngineStatusRow } from "../SettingsHelpers";
import type { TabProps } from "../SettingsHelpers";
import { FolderIcon, PlugIcon } from "../../../lib/icons";
import { AI_HARNESSES } from "../../../lib/ai-harnesses";

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
        <div className="grid grid-cols-2 gap-2">
          {AI_HARNESSES.map((harness) => {
            const selected = settings.default_engine === harness.id;
            const available = engineAvailability?.[harness.id] ?? false;
            return (
              <button
                key={harness.id}
                type="button"
                onClick={() =>
                  setSettings({
                    ...settings,
                    default_engine: harness.id,
                  })
                }
                className={`flex items-center gap-2 px-3 py-2 rounded border text-left transition-colors ${
                  selected
                    ? "border-conduit-500 bg-conduit-600/15"
                    : "border-stroke bg-well hover:bg-raised"
                }`}
              >
                <EngineLogo type={harness.id} size={16} className="text-ink flex-shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink truncate">{harness.name}</span>
                  <span
                    className={`block text-[10px] ${
                      available ? "text-emerald-400" : "text-ink-faint"
                    }`}
                  >
                    {available ? "Installed" : "Not installed"}
                  </span>
                </span>
                {selected && <span className="text-conduit-400 text-xs flex-shrink-0">●</span>}
              </button>
            );
          })}
        </div>
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
          Starting directory for agent sessions.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">MCP Server Setup</label>
          <p className="text-xs text-ink-muted mt-0.5">
            Show the commands to connect each CLI agent to Conduit's MCP server.
          </p>
        </div>
        <button
          onClick={() => setShowMcpSetup(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-raised hover:bg-well rounded flex-shrink-0"
        >
          <PlugIcon size={14} />
          Show setup commands
        </button>
      </div>

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

      <div className="pt-3 border-t border-stroke space-y-2">
        <label className="block text-sm font-medium mb-2">Engine Status</label>
        {AI_HARNESSES.map((harness) => {
          const available = engineAvailability?.[harness.id] ?? false;
          return (
            <EngineStatusRow
              key={harness.id}
              label={harness.name}
              available={available}
              description={available ? harness.loginHintInstalled : harness.loginHintMissing}
            />
          );
        })}
      </div>

      {mcpEnabled && (
        <div className="pt-3 border-t border-stroke">
          <label className="block text-sm font-medium mb-1">MCP Daily Quota</label>
          {mcpDailyQuota === -1 ? (
            <p className="text-xs text-ink-muted">Unlimited MCP tool calls per day.</p>
          ) : (
            <>
              <MCPQuotaCounter variant="block" />
              <p className="text-[10px] text-ink-faint mt-2">
                <button
                  onClick={() => invoke('auth_open_pricing')}
                  className="underline hover:text-ink-muted"
                >
                  Upgrade to Pro for unlimited MCP tool calls.
                </button>
              </p>
            </>
          )}
        </div>
      )}

      {showMcpSetup && <McpSetupDialog onClose={() => setShowMcpSetup(false)} />}
    </div>
  );
}
