import { useState, useCallback, type ReactNode } from "react";
import { toast } from "../common/Toast";
import { invoke } from "../../lib/electron";
import { useVaultStore } from "../../stores/vaultStore";
import {
  defaultSshKeySettings,
  type SshKeyType,
  type RsaBits,
  type EcdsaCurve,
  type SshKeyGenSettings,
  type SshKeyGenResult,
} from "../../utils/sshKeyTypes";
import { Button, Callout, Dialog, FormField, SegmentedControl, TextInput, cx } from "../ui";
import { FULL_WIDTH_SEGMENTS } from "./segments";
import SshKeyOutput from "./SshKeyOutput";
import { errorText } from "../../lib/errorText";

interface SshKeyGeneratorDialogProps {
  onClose: () => void;
  onUseKey?: (privateKey: string, fullResult?: { privateKey: string; publicKey: string; fingerprint: string }) => void;
}

const keyTypes: { value: SshKeyType; label: ReactNode }[] = [
  {
    value: "ed25519",
    label: (
      <>
        Ed25519<span className="ml-1 text-badge opacity-60">recommended</span>
      </>
    ),
  },
  { value: "rsa", label: "RSA" },
  { value: "ecdsa", label: "ECDSA" },
];

const rsaBitsOptions: { value: `${RsaBits}`; label: string }[] = [
  { value: "2048", label: "2048 bits" },
  { value: "4096", label: "4096 bits" },
];

const ecdsaCurveOptions: { value: EcdsaCurve; label: string }[] = [
  { value: "P-256", label: "P-256" },
  { value: "P-384", label: "P-384" },
  { value: "P-521", label: "P-521" },
];

const OPTIONAL = <span className="font-normal text-ink-faint">(optional)</span>;

export default function SshKeyGeneratorDialog({
  onClose,
  onUseKey,
}: SshKeyGeneratorDialogProps) {
  const [settings, setSettings] = useState<SshKeyGenSettings>({
    ...defaultSshKeySettings,
  });
  const [result, setResult] = useState<SshKeyGenResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [passConfirm, setPassConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Save to vault state
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [credentialName, setCredentialName] = useState("");
  const [saving, setSaving] = useState(false);

  const { createCredential, isUnlocked } = useVaultStore();

  const generate = useCallback(async () => {
    if (settings.passphrase && settings.passphrase !== passConfirm) {
      setError("Passphrases do not match");
      return;
    }
    setError(null);
    setGenerating(true);
    try {
      const res = await invoke<SshKeyGenResult>("ssh_generate_keypair", {
        type: settings.type,
        bits: settings.rsaBits,
        curve: settings.ecdsaCurve,
        passphrase: settings.passphrase || undefined,
        comment: settings.comment || undefined,
      });
      setResult(res);
      setShowSaveForm(false);
      // Pre-fill credential name from comment or key type
      setCredentialName(
        settings.comment
          ? `SSH Key - ${settings.comment}`
          : `SSH Key (${settings.type.toUpperCase()})`
      );
    } catch (err) {
      setError(errorText(err, "Failed to generate key pair"));
    } finally {
      setGenerating(false);
    }
  }, [settings, passConfirm]);

  const handleCopyPublic = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.publicKey);
    toast.success("Public key copied to clipboard");
  };

  const handleCopyPrivate = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.privateKey);
    toast.success("Private key copied to clipboard");
  };

  const handleCopyInstallCommand = async () => {
    if (!result) return;
    // Build a one-liner that appends the public key to authorized_keys
    const escapedKey = result.publicKey.replace(/'/g, "'\\''");
    const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${escapedKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
    await navigator.clipboard.writeText(cmd);
    toast.success("Install command copied to clipboard");
  };

  const handleSaveToVault = async () => {
    if (!result || !credentialName.trim()) return;
    setSaving(true);
    try {
      await createCredential({
        name: credentialName.trim(),
        privateKey: result.privateKey,
        tags: ["ssh-key", settings.type],
        credentialType: "ssh_key",
        publicKey: result.publicKey,
        fingerprint: result.fingerprint,
      });
      toast.success("SSH key saved to vault");
      setShowSaveForm(false);
    } catch (err) {
      toast.error(errorText(err, "Failed to save credential"));
    } finally {
      setSaving(false);
    }
  };

  const handleUseKey = () => {
    if (onUseKey && result) {
      onUseKey(result.privateKey, {
        privateKey: result.privateKey,
        publicKey: result.publicKey,
        fingerprint: result.fingerprint,
      });
      onClose();
    }
  };

  const passphraseMismatch =
    settings.passphrase.length > 0 &&
    passConfirm.length > 0 &&
    settings.passphrase !== passConfirm;

  const resultFooter = (
    <div className="w-full space-y-3">
      {showSaveForm && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <TextInput
              value={credentialName}
              onChange={(e) => setCredentialName(e.target.value)}
              placeholder="Credential name..."
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveToVault();
              }}
            />
          </div>
          <Button variant="primary" icon="floppy" loading={saving} onClick={handleSaveToVault} disabled={!credentialName.trim()}>
            Save
          </Button>
          <Button variant="ghost" onClick={() => setShowSaveForm(false)}>
            Cancel
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button
            icon="terminalAlt"
            onClick={handleCopyInstallCommand}
            title="Copy a shell command that adds this public key to a server's authorized_keys"
          >
            Copy Install Command
          </Button>
          {isUnlocked && !showSaveForm && (
            <Button icon="floppy" onClick={() => setShowSaveForm(true)}>
              Save to Vault
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onUseKey && (
            <Button variant="primary" onClick={handleUseKey}>
              Use Private Key
            </Button>
          )}
          <Button
            onClick={async () => {
              await handleCopyPublic();
              onClose();
            }}
          >
            Copy Public Key & Close
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <Dialog
      open
      title="SSH Key Generator"
      onClose={onClose}
      width={result ? 768 : 512}
      footer={result ? resultFooter : <Button onClick={onClose}>Close</Button>}
    >
      {/* Side by side once a key exists */}
      <div className={cx(result && "flex gap-4")}>
        <div className={cx("space-y-4", result && "w-1/2 shrink-0")}>
          <div>
            <label className="mb-1 block text-label font-semibold text-ink-secondary">Key Type</label>
            <SegmentedControl
              options={keyTypes}
              value={settings.type}
              onChange={(type) => setSettings((s) => ({ ...s, type }))}
              className={FULL_WIDTH_SEGMENTS}
            />
          </div>

          {settings.type === "rsa" && (
            <div>
              <label className="mb-1 block text-label font-semibold text-ink-secondary">Key Size</label>
              <SegmentedControl
                options={rsaBitsOptions}
                value={`${settings.rsaBits}`}
                onChange={(bits) => setSettings((s) => ({ ...s, rsaBits: Number(bits) as RsaBits }))}
                className={FULL_WIDTH_SEGMENTS}
              />
            </div>
          )}

          {settings.type === "ecdsa" && (
            <div>
              <label className="mb-1 block text-label font-semibold text-ink-secondary">Curve</label>
              <SegmentedControl
                options={ecdsaCurveOptions}
                value={settings.ecdsaCurve}
                onChange={(ecdsaCurve) => setSettings((s) => ({ ...s, ecdsaCurve }))}
                className={FULL_WIDTH_SEGMENTS}
              />
            </div>
          )}

          <div>
            <FormField label={<>Passphrase {OPTIONAL}</>}>
              <TextInput
                type="password"
                value={settings.passphrase}
                onChange={(e) => setSettings((s) => ({ ...s, passphrase: e.target.value }))}
                placeholder="Leave empty for no passphrase"
              />
            </FormField>
            {settings.passphrase && (
              <div className="mt-2">
                <TextInput
                  type="password"
                  value={passConfirm}
                  onChange={(e) => setPassConfirm(e.target.value)}
                  placeholder="Confirm passphrase"
                  invalid={passphraseMismatch}
                />
              </div>
            )}
            {passphraseMismatch && (
              <p data-cv-error="" className="mt-1 text-meta text-danger">
                Passphrases do not match
              </p>
            )}
          </div>

          <FormField label={<>Comment {OPTIONAL}</>}>
            <TextInput
              value={settings.comment}
              onChange={(e) => setSettings((s) => ({ ...s, comment: e.target.value }))}
              placeholder="user@hostname"
            />
          </FormField>

          <Button
            variant="primary"
            fullWidth
            onClick={generate}
            disabled={passphraseMismatch}
            loading={generating}
            loadingLabel="Generating..."
          >
            {result ? "Regenerate Key Pair" : "Generate Key Pair"}
          </Button>

          {error && <Callout tone="danger">{error}</Callout>}
        </div>

        {result && <SshKeyOutput key={result.fingerprint} result={result} onCopyPublic={handleCopyPublic} onCopyPrivate={handleCopyPrivate} />}
      </div>
    </Dialog>
  );
}
