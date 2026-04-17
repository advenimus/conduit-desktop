import type { TabProps } from "../SettingsHelpers";
import type { TerminalGlobalDefaults } from "../../../types/entry";
import { HARDCODED_TERMINAL_DEFAULTS } from "../../../types/entry";

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
      {/* Default Shell (existing) */}
      <div>
        <label className="block text-sm font-medium mb-1">Default Shell</label>
        <select
          value={settings.default_shell}
          onChange={(e) => setSettings({ ...settings, default_shell: e.target.value })}
          className="w-full px-3 py-2 bg-well border border-stroke rounded"
        >
          <option value="default">System Default</option>
          <option value="bash">Bash</option>
          <option value="zsh">Zsh</option>
          <option value="powershell">PowerShell</option>
        </select>
        <p className="text-xs text-ink-muted mt-1">
          Shell used when opening new local terminal sessions.
        </p>
      </div>

      <div className="border-t border-stroke pt-4">
        <p className="text-xs text-ink-muted mb-4">
          Default settings for all terminal sessions. SSH sessions inherit these values.
        </p>

        {/* Font Size */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">
            Font Size <span className="text-ink-muted font-normal">({defaults.fontSize}px)</span>
          </label>
          <input
            type="range"
            min={8}
            max={32}
            step={1}
            value={defaults.fontSize}
            onChange={(e) => updateTerminal({ fontSize: parseInt(e.target.value) })}
            className="w-full accent-conduit-500"
          />
          <div className="flex justify-between text-[10px] text-ink-faint mt-0.5">
            <span>8px</span>
            <span>32px</span>
          </div>
        </div>

        {/* Scrollback Buffer */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Scrollback Buffer</label>
          <input
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
            className="w-full px-3 py-2 bg-well border border-stroke rounded"
          />
          <p className="text-xs text-ink-muted mt-1">
            Number of lines to keep in the scroll history (100 – 100,000).
          </p>
        </div>

        {/* Cursor Blink */}
        <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={defaults.cursorBlink}
            onChange={(e) => updateTerminal({ cursorBlink: e.target.checked })}
            className="rounded border-stroke-dim bg-well text-conduit-500 focus:ring-conduit-500"
          />
          Cursor Blink
        </label>
      </div>
    </div>
  );
}
