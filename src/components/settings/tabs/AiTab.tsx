import { useState, useEffect } from "react";
import { invoke } from "../../../lib/electron";
import { useAiStore } from "../../../stores/aiStore";
import McpSetupDialog from "../../ai/McpSetupDialog";
import EngineLogo from "../../ai/EngineLogo";
import { EngineStatusRow } from "../SettingsHelpers";
import type { TabProps } from "../SettingsHelpers";
import { FolderIcon, PlugIcon } from "../../../lib/icons";
import { AI_HARNESSES } from "../../../lib/ai-harnesses";
import { Button, IconButton, Slider, TextInput, cx } from "../../ui";
import { CAPTION, HINT, SECTION_LABEL } from "../settings-styles";

export default function AiTab({ settings, setSettings }: TabProps) {
  const engineAvailability = useAiStore((s) => s.engineAvailability);
  const checkEngineAvailability = useAiStore((s) => s.checkEngineAvailability);
  const [showMcpSetup, setShowMcpSetup] = useState(false);

  useEffect(() => {
    checkEngineAvailability();
  }, [checkEngineAvailability]);

  return (
    <div className="space-y-4">
      <div>
        <label className={`${SECTION_LABEL} mb-1`}>Default Engine</label>
        <div className="grid grid-cols-2 gap-2">
          {AI_HARNESSES.map((harness) => {
            const selected = settings.default_engine === harness.id;
            const available = engineAvailability?.[harness.id] ?? false;
            return (
              <button
                key={harness.id}
                type="button"
                data-selected={selected ? "" : undefined}
                onClick={() => setSettings({ ...settings, default_engine: harness.id })}
                className={cx(
                  "flex items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors duration-100",
                  selected ? "border-accent bg-selected-inactive" : "border-card-border bg-well hover:border-(--c-control-border)",
                )}
              >
                <EngineLogo type={harness.id} size={16} className="shrink-0 text-ink" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-ink">{harness.name}</span>
                  <span className={cx("block text-meta", available ? "text-success" : "text-ink-faint")}>
                    {available ? "Installed" : "Not installed"}
                  </span>
                </span>
                {selected && <span className="shrink-0 text-meta text-(--c-accent)">●</span>}
              </button>
            );
          })}
        </div>
        <p className={`mt-2 ${HINT}`}>
          Engine selected by default when opening the AI panel. You can switch anytime in the chat header.
        </p>
      </div>

      <div>
        <label htmlFor="ai-working-directory" className={`${SECTION_LABEL} mb-1`}>Default Working Directory</label>
        <div className="flex items-center gap-2">
          <TextInput
            id="ai-working-directory"
            value={settings.default_working_directory ?? ""}
            onChange={(e) => setSettings({ ...settings, default_working_directory: e.target.value || null })}
            placeholder="Leave empty for home directory"
          />
          <IconButton
            icon={FolderIcon}
            label="Browse"
            onClick={async () => {
              const folder = await invoke<string | null>("dialog_select_folder");
              if (folder) {
                setSettings({ ...settings, default_working_directory: folder });
              }
            }}
          />
        </div>
        <p className={`mt-1 ${HINT}`}>
          Starting directory for agent sessions.
        </p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <label className={SECTION_LABEL}>MCP Server Setup</label>
          <p className={`mt-0.5 ${HINT}`}>
            Show the commands to connect each CLI agent to Conduit's MCP server.
          </p>
        </div>
        <Button icon={PlugIcon} onClick={() => setShowMcpSetup(true)} className="shrink-0">
          Show setup commands
        </Button>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label htmlFor="ai-terminal-font-size" className={SECTION_LABEL}>Terminal Font Size</label>
          <span className={CAPTION}>{settings.cli_font_size}px</span>
        </div>
        <Slider
          id="ai-terminal-font-size"
          min={10}
          max={24}
          value={settings.cli_font_size}
          onChange={(e) => {
            const size = parseInt(e.target.value);
            setSettings({ ...settings, cli_font_size: size });
            document.dispatchEvent(new CustomEvent("conduit:terminal-font-size-change", { detail: { fontSize: size } }));
          }}
          marks={["10px", "", "24px"]}
        />
      </div>

      <div className="space-y-2 border-t border-divider pt-4">
        <label className={`${SECTION_LABEL} mb-2`}>Engine Status</label>
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

      {showMcpSetup && <McpSetupDialog onClose={() => setShowMcpSetup(false)} />}
    </div>
  );
}
