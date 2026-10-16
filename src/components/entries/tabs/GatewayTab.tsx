import { useId, useMemo } from "react";
import type { RdpEntryConfig } from "../../../types/entry";
import { gatewayIdOf } from "../../../lib/rdpGateway";
import { useEntryStore } from "../../../stores/entryStore";
import Field from "../Field";
import { gatewayOptions } from "../gatewayForm";
import { Button, Callout, Select } from "../../ui";

const NONE = "";
const HINT = "text-meta text-ink-muted";

interface GatewayTabProps {
  config: Partial<RdpEntryConfig>;
  onChange: (config: Partial<RdpEntryConfig>) => void;
  /** Opens the New Entry dialog on RD Gateway; the parent selects the new gateway after it saves. */
  onNewGateway: () => void;
}

/** An RDP entry's gateway: none, or one of the vault's gateway objects. */
export default function GatewayTab({ config, onChange, onNewGateway }: GatewayTabProps) {
  const entries = useEntryStore((s) => s.entries);
  const options = useMemo(() => gatewayOptions(entries), [entries]);
  const selectId = useId();

  const gatewayId = gatewayIdOf(config);
  const missing = gatewayId !== undefined && !options.some((o) => o.id === gatewayId);

  const select = (value: string) => onChange({ ...config, gatewayId: value === NONE ? undefined : value });

  return (
    <div className="space-y-4">
      <p className={HINT}>
        A Remote Desktop Gateway lets you reach computers on a private network over HTTPS.
      </p>

      <Field label="Gateway" group htmlFor={selectId}>
        <div className="flex items-center gap-2">
          <Select id={selectId} className="min-w-0 flex-1" value={gatewayId ?? NONE} onChange={(e) => select(e.target.value)}>
            <option value={NONE}>No gateway</option>
            {missing && (
              <option value={gatewayId} disabled>
                Missing gateway
              </option>
            )}
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.address ? `${o.name} (${o.address})` : o.name}
              </option>
            ))}
          </Select>
          <Button size="sm" icon="plus" onClick={onNewGateway}>
            New gateway...
          </Button>
        </div>
      </Field>

      {missing && (
        <Callout tone="warning" size="sm">
          The gateway this entry used was deleted. Pick another gateway, or choose No gateway.
        </Callout>
      )}

      {!missing && options.length === 0 && (
        <p className={HINT}>No gateways in this vault yet. Click New gateway to add one.</p>
      )}
    </div>
  );
}
