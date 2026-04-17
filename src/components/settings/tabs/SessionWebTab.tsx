import type { TabProps } from "../SettingsHelpers";
import type { WebGlobalDefaults, WebEngineType } from "../../../types/entry";
import { HARDCODED_WEB_DEFAULTS } from "../../../types/entry";
import { WEB_ENGINE_OPTIONS } from "../../../lib/sessionOptions";

export default function SessionWebTab({ settings, setSettings }: TabProps) {
  const isWindows = navigator.userAgent.includes("Windows");
  const defaults = settings.session_defaults_web ?? { ...HARDCODED_WEB_DEFAULTS };

  const update = (partial: Partial<WebGlobalDefaults>) => {
    const next = { ...defaults, ...partial };
    setSettings({
      ...settings,
      session_defaults_web: next,
      // Keep legacy field in sync for one release
      default_web_engine: partial.engine ?? settings.default_web_engine,
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-muted">
        Default settings for all web sessions. Individual entries can override these.
      </p>

      {/* Autofill Enabled */}
      <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={defaults.autofillEnabled}
          onChange={(e) => update({ autofillEnabled: e.target.checked })}
          className="rounded border-stroke-dim bg-well text-conduit-500 focus:ring-conduit-500"
        />
        Enable Autofill
      </label>
      <p className="text-xs text-ink-muted -mt-2 ml-6">
        Show an autofill button in web sessions to fill login forms with entry credentials.
      </p>

      {/* Ignore Certificate Errors */}
      <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={defaults.ignoreCertErrors}
          onChange={(e) => update({ ignoreCertErrors: e.target.checked })}
          className="rounded border-stroke-dim bg-well text-conduit-500 focus:ring-conduit-500"
        />
        Ignore Certificate Errors
      </label>
      <p className="text-xs text-ink-muted -mt-2 ml-6">
        Trust self-signed or expired SSL certificates for all web sessions by default.
      </p>

      {/* Browser Engine — Windows only */}
      {isWindows && (
        <div>
          <label className="block text-sm font-medium mb-1">Browser Engine</label>
          <select
            value={defaults.engine}
            onChange={(e) => update({ engine: e.target.value as WebEngineType })}
            className="w-full px-3 py-2 bg-well border border-stroke rounded"
          >
            {WEB_ENGINE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="text-xs text-ink-muted mt-1">
            Edge engine enables Windows integrated authentication for Microsoft 365 and domain SSO.
            Individual connections can override this in their Security settings.
          </p>
        </div>
      )}
    </div>
  );
}
