import type { CommandEntryConfig } from "../../../types/entry";
import Field from "../Field";
import { Callout, Checkbox, Radio, RadioGroup, Select, TextInput } from "../../ui";

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
      <Field label="Command" required>
        <TextInput
          value={config.command}
          onChange={(e) => update({ command: e.target.value })}
          placeholder="/usr/bin/code, whoami, etc."
          className="font-mono"
        />
      </Field>

      <Field label="Arguments">
        <TextInput
          value={config.args ?? ""}
          onChange={(e) => update({ args: e.target.value })}
          placeholder="--new-window /path/to/project"
          className="font-mono"
        />
      </Field>

      <Field label="Working Directory">
        <TextInput
          value={config.workingDir ?? ""}
          onChange={(e) => update({ workingDir: e.target.value })}
          placeholder="Leave empty for home directory"
          className="font-mono"
        />
      </Field>

      <Field label="Shell" description="Shell used to wrap the command. Default uses the system shell.">
        <Select value={config.shell ?? ""} onChange={(e) => update({ shell: e.target.value })}>
          {SHELL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Run As" group>
        <RadioGroup
          name="runAsMode"
          value={config.runAsMode}
          onChange={(runAsMode) => update({ runAsMode })}
          className="mt-1"
        >
          <Radio value="credential">Credential user</Radio>
          <p className="-mt-1 ml-6 text-meta text-ink-muted">
            Uses the credential from the Credentials tab to run as that user
          </p>
          <Radio value="current">Current user</Radio>
          <p className="-mt-1 ml-6 text-meta text-ink-muted">
            No credential needed — runs as the logged-in user
          </p>
        </RadioGroup>
      </Field>

      <div className="space-y-2">
        <Checkbox checked={config.guiApp ?? false} onChange={(guiApp) => update({ guiApp })}>
          GUI Application
        </Checkbox>
        {config.guiApp && (
          <Callout tone="warning" size="sm">
            {navigator.platform.startsWith("Mac") ? (
              <span>Target user must have an active login session (Fast User Switching).</span>
            ) : navigator.platform.startsWith("Win") ? (
              <span>Windows handles GUI app permissions automatically.</span>
            ) : isWayland ? (
              <span>Cross-user GUI launch is not supported on Wayland.</span>
            ) : (
              <span>Requires display access for the target user (xhost will be configured automatically).</span>
            )}
          </Callout>
        )}
      </div>

      <Field label="Timeout (seconds)" description="0 = no timeout. The process will run until it exits or is manually stopped.">
        <TextInput
          type="number"
          value={config.timeout ?? 0}
          onChange={(e) => update({ timeout: parseInt(e.target.value, 10) || 0 })}
          min={0}
          className="max-w-32"
        />
      </Field>
    </div>
  );
}
