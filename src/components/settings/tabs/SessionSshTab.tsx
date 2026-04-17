import type { TabProps } from "../SettingsHelpers";
import type { SshGlobalDefaults, SshAuthMethod } from "../../../types/entry";
import { HARDCODED_SSH_DEFAULTS } from "../../../types/entry";

const AUTH_METHOD_OPTIONS: { value: SshAuthMethod; label: string }[] = [
  { value: "key", label: "SSH Key" },
  { value: "password", label: "Password" },
];

export default function SessionSshTab({ settings, setSettings }: TabProps) {
  const defaults = settings.session_defaults_ssh ?? { ...HARDCODED_SSH_DEFAULTS };

  const updateSsh = (partial: Partial<SshGlobalDefaults>) => {
    setSettings({
      ...settings,
      session_defaults_ssh: { ...defaults, ...partial },
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-muted">
        Default settings for SSH connections. Individual entries or credentials can override these.
      </p>

      <div>
        <label className="block text-sm font-medium mb-1">
          Auth Method When Key Present
        </label>
        <p className="text-xs text-ink-muted mb-2">
          When a credential has both an SSH key and a password, which method to use by default.
        </p>
        <div className="flex gap-1 p-1 bg-well rounded-lg">
          {AUTH_METHOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => updateSsh({ authMethodWhenKeyPresent: opt.value })}
              className={`flex-1 py-1.5 px-3 text-sm rounded-md transition-colors ${
                defaults.authMethodWhenKeyPresent === opt.value
                  ? "bg-conduit-600 text-white"
                  : "hover:bg-raised text-ink-muted"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
