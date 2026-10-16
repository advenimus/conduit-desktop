import { useId, useState } from "react";
import { useVaultStore } from "../../../stores/vaultStore";
import CredentialPicker from "../../vault/CredentialPicker";
import Field from "../Field";
import type { GatewayLoginChoice } from "../gatewayForm";
import { IconButton, PasswordInput, Radio, RadioGroup, TextInput } from "../../ui";

const HINT = "text-meta text-ink-muted";
const PICKER_BUTTON =
  "h-control w-full rounded border border-input-border bg-input px-1.5 text-left text-body text-(--c-input-fg) hover:border-(--c-control-border)";

interface GatewayLoginTabProps {
  login: GatewayLoginChoice;
  setLogin: (login: GatewayLoginChoice) => void;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  domain: string;
  setDomain: (v: string) => void;
  credentialId: string | null;
  setCredentialId: (id: string | null) => void;
  showErrors: boolean;
}

/** How a gateway object signs in to the gateway. */
export default function GatewayLoginTab({
  login,
  setLogin,
  username,
  setUsername,
  password,
  setPassword,
  domain,
  setDomain,
  credentialId,
  setCredentialId,
  showErrors,
}: GatewayLoginTabProps) {
  const credentials = useVaultStore((s) => s.credentials);
  const [showPicker, setShowPicker] = useState(false);
  const pickerId = useId();
  const credentialName = credentialId ? credentials.find((c) => c.id === credentialId)?.name ?? "Unknown credential" : null;

  return (
    <div className="space-y-4">
      <RadioGroup<GatewayLoginChoice> value={login} onChange={setLogin} aria-label="Gateway login">
        <Radio value="typed">Type a login</Radio>
        <Radio value="saved">Use a saved credential</Radio>
        <Radio value="connection">Use the RDP entry's login</Radio>
      </RadioGroup>

      {login === "typed" && (
        <div className="space-y-4">
          <Field label="Username">
            <TextInput value={username} onChange={(e) => setUsername(e.target.value)} placeholder="CORP\alice" />
          </Field>
          <Field label="Password">
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Domain">
            <TextInput value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="CORP" />
          </Field>
        </div>
      )}

      {login === "saved" && (
        <Field label="Saved credential" group htmlFor={pickerId}>
          <div className="flex items-center gap-1">
            <button id={pickerId} type="button" onClick={() => setShowPicker(true)} className={PICKER_BUTTON}>
              {credentialName ?? <span className="text-(--c-input-placeholder)">Choose a credential</span>}
            </button>
            {credentialId && (
              <IconButton size="sm" icon="close" label="Clear gateway credential" onClick={() => setCredentialId(null)} />
            )}
          </div>
          {showErrors && !credentialId && (
            <p data-cv-error="" className="mt-1 text-meta text-danger">
              Pick a saved credential for the gateway login.
            </p>
          )}
        </Field>
      )}

      {login === "connection" && (
        <p className={HINT}>
          Each RDP entry that uses this gateway signs in to it with its own username and password.
        </p>
      )}

      {showPicker && (
        <CredentialPicker
          selectedId={credentialId}
          onSelect={setCredentialId}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
