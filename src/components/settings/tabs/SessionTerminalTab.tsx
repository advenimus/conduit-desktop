import type { TabProps } from "../SettingsHelpers";
import type { TerminalGlobalDefaults } from "../../../types/entry";
import { HARDCODED_TERMINAL_DEFAULTS } from "../../../types/entry";
import { Checkbox, FormField, Select, Slider, TextInput } from "../../ui";
import { HINT, SECTION_LABEL } from "../settings-styles";

export default function SessionTerminalTab({ settings, setSettings }: TabProps) {
  const defaults = settings.session_defaults_terminal ?? { ...HARDCODED_TERMINAL_DEFAULTS };

  const updateTerminal = (partial: Partial<TerminalGlobalDefaults>) => {
    setSettings({
      ...settings,
      session_defaults_terminal: { ...defaults, ...partial },
    });
  };

  return (
    <div className="space-y-4">
      <FormField label="Default Shell" description="Shell used when opening new local terminal sessions.">
        <Select value={settings.default_shell} onChange={(e) => setSettings({ ...settings, default_shell: e.target.value })}>
          <option value="default">System Default</option>
          <option value="bash">Bash</option>
          <option value="zsh">Zsh</option>
          <option value="powershell">PowerShell</option>
        </Select>
      </FormField>

      <div className="space-y-4 border-t border-divider pt-4">
        <p className={HINT}>
          Default settings for all terminal sessions. SSH sessions inherit these values.
        </p>

        <div>
          <label htmlFor="terminal-font-size" className={`${SECTION_LABEL} mb-1`}>
            Font Size <span className="font-normal text-ink-muted">({defaults.fontSize}px)</span>
          </label>
          <Slider
            id="terminal-font-size"
            min={8}
            max={32}
            step={1}
            value={defaults.fontSize}
            onChange={(e) => updateTerminal({ fontSize: parseInt(e.target.value) })}
            marks={["8px", "", "32px"]}
          />
        </div>

        <FormField label="Scrollback Buffer" description="Number of lines to keep in the scroll history (100 – 100,000).">
          <TextInput
            type="number"
            min={100}
            max={100000}
            step={100}
            value={defaults.scrollback}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              if (!isNaN(val)) {
                updateTerminal({ scrollback: Math.max(100, Math.min(100000, val)) });
              }
            }}
          />
        </FormField>

        <Checkbox checked={defaults.cursorBlink} onChange={(cursorBlink) => updateTerminal({ cursorBlink })}>
          Cursor Blink
        </Checkbox>
      </div>
    </div>
  );
}
