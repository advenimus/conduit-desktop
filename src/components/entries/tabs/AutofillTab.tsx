import type { WebAutofillConfig, WebGlobalDefaults } from "../../../types/entry";
import DefaultableCheckbox from "../DefaultableCheckbox";
import Field from "../Field";

interface AutofillTabProps {
  config: Partial<WebAutofillConfig>;
  onChange: (config: Partial<WebAutofillConfig>) => void;
  globalDefaults: WebGlobalDefaults;
}

export default function AutofillTab({ config, onChange, globalDefaults }: AutofillTabProps) {
  const update = (partial: Partial<WebAutofillConfig>) => {
    onChange({ ...config, ...partial });
  };

  // Effective enabled: per-entry override or global default
  const effectiveEnabled = config.enabled ?? globalDefaults.autofillEnabled;

  return (
    <div className="space-y-4">
      {/* Enable toggle */}
      <DefaultableCheckbox
        value={config.enabled}
        defaultValue={globalDefaults.autofillEnabled}
        label="Enable Autofill"
        onChange={(v) => update({ enabled: v })}
      />
      <p className="text-xs text-ink-faint -mt-2">
        Show an autofill button in web sessions to fill login forms with entry credentials.
      </p>

      {effectiveEnabled && (
        <>
          {/* Login URL Pattern */}
          <Field label="Login URL Pattern">
            <input
              type="text"
              value={config.loginUrlPattern ?? ""}
              onChange={(e) => update({ loginUrlPattern: e.target.value || undefined })}
              placeholder="e.g., /login|signin|auth/"
              className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
            />
            <p className="text-xs text-ink-faint mt-1">
              Optional regex pattern. Autofill button only activates when the page URL matches. Leave empty to allow on any page.
            </p>
          </Field>

          {/* Multi-step login */}
          <div>
            <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={config.multiStepLogin ?? false}
                onChange={(e) => update({ multiStepLogin: e.target.checked })}
                className="rounded border-stroke-dim bg-well text-conduit-500 focus:ring-conduit-500"
              />
              Multi-step Login
            </label>
            <p className="text-xs text-ink-faint mt-1 ml-6">
              Enable for sites that split login across multiple pages (Microsoft, Google, Okta).
              Username is filled and submitted first, then password is filled on the next page.
            </p>
          </div>

          {/* Selector Overrides */}
          <div className="border-t border-stroke pt-4">
            <h4 className="text-sm font-medium text-ink-secondary mb-3">Selector Overrides</h4>
            <p className="text-xs text-ink-faint mb-3">
              CSS selectors like <code className="px-1 py-0.5 bg-raised rounded text-ink-muted">#email</code>,{" "}
              <code className="px-1 py-0.5 bg-raised rounded text-ink-muted">.login-form input[name='user']</code>.
              Leave empty for automatic detection.
            </p>
            <div className="space-y-3">
              <Field label="Username Field">
                <input
                  type="text"
                  value={config.usernameSelector ?? ""}
                  onChange={(e) => update({ usernameSelector: e.target.value || undefined })}
                  placeholder="Auto-detect"
                  className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
                />
              </Field>
              <Field label="Password Field">
                <input
                  type="text"
                  value={config.passwordSelector ?? ""}
                  onChange={(e) => update({ passwordSelector: e.target.value || undefined })}
                  placeholder="Auto-detect"
                  className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
                />
              </Field>
              <Field label="Submit / Next Button">
                <input
                  type="text"
                  value={config.submitSelector ?? ""}
                  onChange={(e) => update({ submitSelector: e.target.value || undefined })}
                  placeholder="Auto-detect"
                  className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
                />
              </Field>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
