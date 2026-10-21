import { useId, useState } from "react";
import { RDP_GATEWAY_DEFAULT_PORT, type RdGatewayConfig, type RdpGatewayTransport } from "../../../lib/rdpGateway";
import Field from "../Field";
import { GATEWAY_TRANSPORT_OPTIONS, describeGatewayUsage, splitGatewayHostInput } from "../gatewayForm";
import { Button, Checkbox, FormField, Select, TextInput } from "../../ui";

const HINT = "text-meta text-ink-muted";

interface GatewayServerTabProps {
  config: Partial<RdGatewayConfig>;
  onChange: (config: Partial<RdGatewayConfig>) => void;
  /** Shown under the fields; null for a gateway that is not saved yet. */
  usageCount: number | null;
  showErrors: boolean;
}

/** The address settings of a gateway object. */
export default function GatewayServerTab({ config, onChange, usageCount, showErrors }: GatewayServerTabProps) {
  const [showAdvanced, setShowAdvanced] = useState(
    (config.gatewayTransport !== undefined && config.gatewayTransport !== "auto") || config.gatewayLegacyTls === true,
  );
  const transportId = useId();
  const update = (partial: Partial<RdGatewayConfig>) => onChange({ ...config, ...partial });

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
        A Remote Desktop Gateway lets you reach computers on a private network over HTTPS. RDP entries pick it in their Gateway settings.
      </p>

      <div className="flex gap-3">
        <FormField
          label="Gateway server"
          className="min-w-0 flex-1"
          error={showErrors && !config.gatewayHostname?.trim() ? "Enter a gateway server." : null}
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
          <div className="space-y-4">
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
            <Checkbox
              checked={config.gatewayLegacyTls === true}
              onChange={(checked) => update({ gatewayLegacyTls: checked || undefined })}
              description="For old gateways that only offer TLS 1.0 or 1.1, or lack secure renegotiation. Less secure; turn it on only if the gateway fails without it."
            >
              Allow old TLS
            </Checkbox>
          </div>
        )}
      </div>

      {usageCount !== null && <p className={HINT}>{describeGatewayUsage(usageCount)}</p>}
    </div>
  );
}
