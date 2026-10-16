import { useId, useState } from "react";
import type { RdpEntryConfig, RdpGlobalDefaults } from "../../../types/entry";
import type { RdpGatewayTransport } from "../../../lib/rdpGateway";
import { RDP_GATEWAY_DEFAULT_PORT } from "../../../lib/rdpGateway";
import { useVaultStore } from "../../../stores/vaultStore";
import CredentialPicker from "../../vault/CredentialPicker";
import Field from "../Field";
import { GATEWAY_TRANSPORT_OPTIONS, describeDefaultGateway, gatewayValidationError, splitGatewayHostInput } from "../gatewayForm";
import { Button, Checkbox, FormField, IconButton, Radio, RadioGroup, Select, TextInput } from "../../ui";

type ModeChoice = "default" | "off" | "custom";
type LoginChoice = "same" | "credential";

const SECTION = "text-label font-semibold text-ink-secondary";
const HINT = "text-meta text-ink-muted";

interface GatewayTabProps {
  config: Partial<RdpEntryConfig>;
  onChange: (config: Partial<RdpEntryConfig>) => void;
  globalDefaults: RdpGlobalDefaults;
}

export default function GatewayTab({ config, onChange, globalDefaults }: GatewayTabProps) {
  const credentials = useVaultStore((s) => s.credentials);
  const [showPicker, setShowPicker] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(config.gatewayTransport !== undefined && config.gatewayTransport !== "auto");
  const transportId = useId();
  const pickerId = useId();

  const mode: ModeChoice = config.gatewayMode === "off" || config.gatewayMode === "custom" ? config.gatewayMode : "default";
  const login: LoginChoice = config.gatewayCredentialMode === "credential" ? "credential" : "same";
  const update = (partial: Partial<RdpEntryConfig>) => onChange({ ...config, ...partial });

  const defaultText = describeDefaultGateway(globalDefaults);
  const error = gatewayValidationError(config);
  const credentialId = config.gatewayCredentialId;
  const credentialName = credentialId ? credentials.find((c) => c.id === credentialId)?.name ?? "Unknown credential" : null;

  const setMode = (next: ModeChoice) => update({ gatewayMode: next === "default" ? undefined : next });
  const setLogin = (next: LoginChoice) =>
    update(next === "same" ? { gatewayCredentialMode: undefined, gatewayCredentialId: undefined } : { gatewayCredentialMode: "credential" });

  const commitHost = () => {
    if (config.gatewayHostname === undefined) return;
    const split = splitGatewayHostInput(config.gatewayHostname, config.gatewayPort);
    if (split.gatewayHostname !== config.gatewayHostname || split.gatewayPort !== config.gatewayPort) update(split);
  };

  const onPortChange = (value: string) => {
    const port = value.trim() === "" ? undefined : Number(value);
    update({ gatewayPort: port !== undefined && Number.isFinite(port) ? port : undefined });
  };

  return (
    <div className="space-y-4">
      <p className={HINT}>
        A Remote Desktop Gateway lets you reach computers on a private network over HTTPS.
      </p>

      <div className="space-y-2">
        <div className={SECTION}>Gateway</div>
        <RadioGroup<ModeChoice> value={mode} onChange={setMode} aria-label="Gateway">
          <Radio value="default">Use default gateway</Radio>
          <Radio value="off">No gateway</Radio>
          <Radio value="custom">Custom gateway</Radio>
        </RadioGroup>
        {mode === "default" && (
          <div className="pl-6">
            {defaultText ? (
              <p className="text-body text-ink-secondary">{defaultText}</p>
            ) : (
              <>
                <p className="text-body text-ink-secondary">No default gateway set</p>
                <p className={HINT}>You can set one in Settings &gt; Sessions &gt; RDP.</p>
              </>
            )}
          </div>
        )}
      </div>

      {mode === "custom" && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <FormField
              label="Gateway server"
              className="min-w-0 flex-1"
              error={!config.gatewayHostname?.trim() ? error : null}
            >
              <TextInput
                value={config.gatewayHostname ?? ""}
                onChange={(e) => update({ gatewayHostname: e.target.value })}
                onBlur={commitHost}
                placeholder="gateway.example.com"
              />
            </FormField>
            <Field label="Port" className="w-28">
              <TextInput
                type="number"
                min={1}
                max={65535}
                value={config.gatewayPort ?? ""}
                onChange={(e) => onPortChange(e.target.value)}
                placeholder={String(RDP_GATEWAY_DEFAULT_PORT)}
              />
            </Field>
          </div>

          <Checkbox
            checked={config.gatewayBypassLocal === true}
            onChange={(checked) => update({ gatewayBypassLocal: checked || undefined })}
            description="Connect straight to the computer when it is on your local network."
          >
            Skip the gateway for local addresses
          </Checkbox>

          <div className="space-y-2">
            <Button
              variant="ghost"
              size="sm"
              icon={showAdvanced ? "chevronDown" : "chevronRight"}
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              Advanced
            </Button>
            {showAdvanced && (
              <Field
                label="Transport"
                group
                htmlFor={transportId}
                description="Automatic tries HTTP first, then RPC. Change it only if your gateway needs one of them."
              >
                <Select
                  id={transportId}
                  value={config.gatewayTransport ?? "auto"}
                  onChange={(e) => {
                    const value = e.target.value as RdpGatewayTransport;
                    update({ gatewayTransport: value === "auto" ? undefined : value });
                  }}
                >
                  {GATEWAY_TRANSPORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        </div>
      )}

      {mode !== "off" && (
        <div className="space-y-2">
          <div className={SECTION}>Gateway login</div>
          <RadioGroup<LoginChoice> value={login} onChange={setLogin} aria-label="Gateway login">
            <Radio value="same">Same login as this computer</Radio>
            <Radio value="credential">Use a saved credential</Radio>
          </RadioGroup>
          {login === "credential" && (
            <div className="pl-6">
              <div className="flex items-center gap-1">
                <button
                  id={pickerId}
                  type="button"
                  onClick={() => setShowPicker(true)}
                  className="h-control w-full rounded border border-input-border bg-input px-1.5 text-left text-body text-(--c-input-fg) hover:border-(--c-control-border)"
                >
                  {credentialName ?? <span className="text-(--c-input-placeholder)">Choose a credential</span>}
                </button>
                {credentialId && (
                  <IconButton
                    size="sm"
                    icon="close"
                    label="Clear gateway credential"
                    onClick={() => update({ gatewayCredentialId: undefined })}
                  />
                )}
              </div>
              {!credentialId && error && <p data-cv-error="" className="mt-1 text-meta text-danger">{error}</p>}
            </div>
          )}
        </div>
      )}

      {showPicker && (
        <CredentialPicker
          selectedId={credentialId ?? null}
          onSelect={(id) => update({ gatewayCredentialId: id ?? undefined })}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
