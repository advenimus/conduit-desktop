import type { TabProps } from "../SettingsHelpers";
import type { SshGlobalDefaults, SshAuthMethod } from "../../../types/entry";
import { HARDCODED_SSH_DEFAULTS } from "../../../types/entry";
import { SegmentedControl, type SegmentOption } from "../../ui";
import { HINT, SECTION_LABEL } from "../settings-styles";

const AUTH_METHOD_OPTIONS: ReadonlyArray<SegmentOption<SshAuthMethod>> = [
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
      <p className={HINT}>
        Default settings for SSH connections. Individual entries or credentials can override these.
      </p>

      <div>
        <label id="ssh-auth-method-label" className={`${SECTION_LABEL} mb-1`}>
          Auth Method When Key Present
        </label>
        <p className={`mb-2 ${HINT}`}>
          When a credential has both an SSH key and a password, which method to use by default.
        </p>
        <SegmentedControl
          aria-labelledby="ssh-auth-method-label"
          options={AUTH_METHOD_OPTIONS}
          value={defaults.authMethodWhenKeyPresent}
          onChange={(authMethodWhenKeyPresent) => updateSsh({ authMethodWhenKeyPresent })}
          className="flex w-full [&>button]:flex-1 [&>button]:justify-center"
        />
      </div>
    </div>
  );
}
