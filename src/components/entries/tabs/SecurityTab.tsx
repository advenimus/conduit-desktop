import type { EntryType, RdpEntryConfig, WebEntryConfig, WebEngineType, RdpGlobalDefaults, WebGlobalDefaults } from "../../../types/entry";
import { WEB_ENGINE_OPTIONS } from "../../../lib/sessionOptions";
import DefaultableCheckbox from "../DefaultableCheckbox";
import DefaultableSelect from "../DefaultableSelect";
import Field from "../Field";

interface SecurityTabProps {
  entryType: EntryType;
  rdpConfig: Partial<RdpEntryConfig>;
  onRdpConfigChange: (config: Partial<RdpEntryConfig>) => void;
  webConfig: Partial<WebEntryConfig>;
  onWebConfigChange: (config: Partial<WebEntryConfig>) => void;
  host: string;
  rdpGlobalDefaults: RdpGlobalDefaults;
  webGlobalDefaults: WebGlobalDefaults;
}

export default function SecurityTab({
  entryType,
  rdpConfig,
  onRdpConfigChange,
  webConfig,
  onWebConfigChange,
  host,
  rdpGlobalDefaults,
  webGlobalDefaults,
}: SecurityTabProps) {
  if (entryType === "rdp") {
    const update = (partial: Partial<RdpEntryConfig>) => {
      onRdpConfigChange({ ...rdpConfig, ...partial });
    };

    return (
      <div className="space-y-3">
        {/* NLA */}
        <DefaultableCheckbox
          value={rdpConfig.enableNla}
          defaultValue={rdpGlobalDefaults.enableNla}
          label="NLA (Network Level Auth)"
          onChange={(v) => update({ enableNla: v })}
        />

        {/* Hostname — per-entry only */}
        <Field label="Hostname (optional)">
          <input
            type="text"
            value={rdpConfig.hostname || ""}
            onChange={(e) => update({ hostname: e.target.value })}
            placeholder="e.g., windows-server.local"
            className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
          />
          <p className="text-xs text-ink-faint mt-1">
            To avoid 6-second connection delays with NLA, add this IP to{" "}
            <code className="px-1 py-0.5 bg-raised rounded text-ink-muted">/etc/hosts</code> with a hostname.
            <br />
            Example:{" "}
            <code className="px-1 py-0.5 bg-raised rounded text-ink-muted">
              {host || "192.0.2.10"} windows-server.local
            </code>
          </p>
        </Field>

        {/* Warning: IP + NLA without hostname */}
        {(rdpConfig.enableNla ?? rdpGlobalDefaults.enableNla) &&
          host &&
          /^\d+\.\d+\.\d+\.\d+$/.test(host) &&
          !rdpConfig.hostname && (
          <div className="px-3 py-2 bg-yellow-500/10 border border-yellow-500/30 rounded text-sm">
            <div className="flex items-start gap-2">
              <span className="text-yellow-500 mt-0.5">&#9888;&#65039;</span>
              <div className="flex-1">
                <div className="font-medium text-yellow-400 mb-1">
                  NLA with IP address causes 6-second delays
                </div>
                <div className="text-ink-secondary text-xs">
                  <strong>To fix:</strong> Add{" "}
                  <code className="px-1 py-0.5 bg-raised rounded">
                    {host} my-server.local
                  </code>{" "}
                  to{" "}
                  <code className="px-1 py-0.5 bg-raised rounded">/etc/hosts</code>{" "}
                  and enter the hostname above.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (entryType === "web") {
    const isWindows = navigator.userAgent.includes("Windows");
    return (
      <div className="space-y-3">
        <DefaultableCheckbox
          value={webConfig.ignoreCertErrors}
          defaultValue={webGlobalDefaults.ignoreCertErrors}
          label="Ignore certificate errors"
          onChange={(v) => onWebConfigChange({ ...webConfig, ignoreCertErrors: v })}
        />
        <p className="text-xs text-ink-faint ml-0">
          Trust self-signed or expired SSL certificates. Use for internal services on trusted networks.
        </p>

        {/* Browser Engine — Windows only */}
        {isWindows && (
          <Field label="Browser Engine">
            <DefaultableSelect<string>
              value={webConfig.engine}
              defaultLabel={WEB_ENGINE_OPTIONS.find((o) => o.value === webGlobalDefaults.engine)?.label ?? "Auto"}
              options={WEB_ENGINE_OPTIONS}
              onChange={(v) => onWebConfigChange({ ...webConfig, engine: v as WebEngineType })}
            />
            <p className="text-xs text-ink-faint mt-1">
              Edge engine enables Windows integrated authentication for Microsoft 365 and domain SSO.
            </p>
          </Field>
        )}
      </div>
    );
  }

  return null;
}
