import type { CommandEntryConfig } from "../../../types/entry";
import Field from "../Field";
import { AlertTriangleIcon } from "../../../lib/icons";

interface CommandTabProps {
  config: CommandEntryConfig;
  onChange: (config: CommandEntryConfig) => void;
}

const SHELL_OPTIONS = [
  { value: "", label: "Default" },
  { value: "bash", label: "bash" },
  { value: "zsh", label: "zsh" },
  { value: "sh", label: "sh" },
  ...(navigator.platform.startsWith("Win")
    ? [
        { value: "pwsh", label: "PowerShell" },
        { value: "cmd", label: "cmd" },
      ]
    : []),
];

export default function CommandTab({ config, onChange }: CommandTabProps) {
  const update = (partial: Partial<CommandEntryConfig>) => {
    onChange({ ...config, ...partial });
  };

  const isWayland =
    !navigator.platform.startsWith("Win") &&
    !navigator.platform.startsWith("Mac");

  return (
    <div className="space-y-4">
      {/* Command */}
      <Field label="Command" required>
        <input
          type="text"
          value={config.command}
          onChange={(e) => update({ command: e.target.value })}
          placeholder="/usr/bin/code, whoami, etc."
          className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500 font-mono"
        />
      </Field>

      {/* Arguments */}
      <Field label="Arguments">
        <input
          type="text"
          value={config.args ?? ""}
          onChange={(e) => update({ args: e.target.value })}
          placeholder="--new-window /path/to/project"
          className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500 font-mono"
        />
      </Field>

      {/* Working Directory */}
      <Field label="Working Directory">
        <input
          type="text"
          value={config.workingDir ?? ""}
          onChange={(e) => update({ workingDir: e.target.value })}
          placeholder="Leave empty for home directory"
          className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500 font-mono"
        />
      </Field>

      {/* Shell */}
      <Field label="Shell">
        <select
          value={config.shell ?? ""}
          onChange={(e) => update({ shell: e.target.value })}
          className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
        >
          {SHELL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-ink-faint mt-1">
          Shell used to wrap the command. Default uses the system shell.
        </p>
      </Field>

      {/* Run As Mode */}
      <div>
        <label className="block text-sm font-medium text-ink-secondary mb-2">
          Run As
        </label>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="runAsMode"
              checked={config.runAsMode === "credential"}
              onChange={() => update({ runAsMode: "credential" })}
              className="text-conduit-500 focus:ring-conduit-500"
            />
            <span>Credential user</span>
          </label>
          <p className="text-xs text-ink-faint ml-6">
            Uses the credential from the Credentials tab to run as that user
          </p>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="runAsMode"
              checked={config.runAsMode === "current"}
              onChange={() => update({ runAsMode: "current" })}
              className="text-conduit-500 focus:ring-conduit-500"
            />
            <span>Current user</span>
          </label>
          <p className="text-xs text-ink-faint ml-6">
            No credential needed — runs as the logged-in user
          </p>
        </div>
      </div>

      {/* GUI Application */}
      <div>
        <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={config.guiApp ?? false}
            onChange={(e) => update({ guiApp: e.target.checked })}
            className="rounded border-stroke-dim bg-well text-conduit-500 focus:ring-conduit-500"
          />
          GUI Application
        </label>
        {config.guiApp && (
          <div className="mt-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded text-xs">
            <div className="flex items-start gap-2">
              <AlertTriangleIcon size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
              <div className="text-ink-muted">
                {navigator.platform.startsWith("Mac") ? (
                  <span>Target user must have an active login session (Fast User Switching).</span>
                ) : navigator.platform.startsWith("Win") ? (
                  <span>Windows handles GUI app permissions automatically.</span>
                ) : isWayland ? (
                  <span>Cross-user GUI launch is not supported on Wayland.</span>
                ) : (
                  <span>Requires display access for the target user (xhost will be configured automatically).</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Timeout */}
      <Field label="Timeout (seconds)">
        <input
          type="number"
          value={config.timeout ?? 0}
          onChange={(e) => update({ timeout: parseInt(e.target.value, 10) || 0 })}
          min={0}
          className="w-32 px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
        />
        <p className="text-xs text-ink-faint mt-1">
          0 = no timeout. The process will run until it exits or is manually stopped.
        </p>
      </Field>
    </div>
  );
}
