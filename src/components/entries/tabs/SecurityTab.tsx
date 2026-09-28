import type { EntryType, RdpEntryConfig, WebEntryConfig, WebEngineType, RdpGlobalDefaults, WebGlobalDefaults } from "../../../types/entry";
import { WEB_ENGINE_OPTIONS } from "../../../lib/sessionOptions";
import DefaultableCheckbox from "../DefaultableCheckbox";
import DefaultableSelect from "../DefaultableSelect";
import Field from "../Field";
import { Callout, TextInput } from "../../ui";

const CODE = "rounded bg-code px-1 py-0.5 font-mono text-ink-secondary";

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
        <Field
          label="Hostname (optional)"
          description={
            <>
              To avoid 6-second connection delays with NLA, add this IP to <code className={CODE}>/etc/hosts</code> with a hostname.
              <br />
              Example: <code className={CODE}>{host || "192.0.2.10"} windows-server.local</code>
            </>
          }
        >
          <TextInput
            value={rdpConfig.hostname || ""}
            onChange={(e) => update({ hostname: e.target.value })}
            placeholder="e.g., windows-server.local"
          />
        </Field>

        {/* Warning: IP + NLA without hostname */}
        {(rdpConfig.enableNla ?? rdpGlobalDefaults.enableNla) &&
          host &&
          /^\d+\.\d+\.\d+\.\d+$/.test(host) &&
          !rdpConfig.hostname && (
          <Callout tone="warning" title="NLA with IP address causes 6-second delays">
            <strong>To fix:</strong> Add <code className={CODE}>{host} my-server.local</code> to{" "}
            <code className={CODE}>/etc/hosts</code> and enter the hostname above.
          </Callout>
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
        <p className="text-meta text-ink-muted">
          Trust self-signed or expired SSL certificates. Use for internal services on trusted networks.
        </p>

        {/* Browser Engine — Windows only */}
        {isWindows && (
          <Field
            label="Browser Engine"
            description="Edge engine enables Windows integrated authentication for Microsoft 365 and domain SSO."
          >
            <DefaultableSelect<string>
              value={webConfig.engine}
              defaultLabel={WEB_ENGINE_OPTIONS.find((o) => o.value === webGlobalDefaults.engine)?.label ?? "Auto"}
              options={WEB_ENGINE_OPTIONS}
              onChange={(v) => onWebConfigChange({ ...webConfig, engine: v as WebEngineType })}
            />
          </Field>
        )}
      </div>
    );
  }

  return null;
}
