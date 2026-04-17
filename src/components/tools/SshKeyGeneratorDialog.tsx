import { useState, useCallback } from "react";
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
import {
  CloseIcon, CopyIcon, EyeIcon, EyeOffIcon, FloppyIcon, LoaderIcon, TerminalAltIcon
} from "../../lib/icons";

interface SshKeyGeneratorDialogProps {
  onClose: () => void;
  onUseKey?: (privateKey: string, fullResult?: { privateKey: string; publicKey: string; fingerprint: string }) => void;
}

const keyTypes: { value: SshKeyType; label: string }[] = [
  { value: "ed25519", label: "Ed25519" },
  { value: "rsa", label: "RSA" },
  { value: "ecdsa", label: "ECDSA" },
];

const rsaBitsOptions: RsaBits[] = [2048, 4096];
const ecdsaCurveOptions: { value: EcdsaCurve; label: string }[] = [
  { value: "P-256", label: "P-256" },
  { value: "P-384", label: "P-384" },
  { value: "P-521", label: "P-521" },
];

export default function SshKeyGeneratorDialog({
  onClose,
  onUseKey,
}: SshKeyGeneratorDialogProps) {
  const [settings, setSettings] = useState<SshKeyGenSettings>({
    ...defaultSshKeySettings,
  });
  const [result, setResult] = useState<SshKeyGenResult | null>(null);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
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
      setShowPrivateKey(false);
      setShowSaveForm(false);
      // Pre-fill credential name from comment or key type
      setCredentialName(
        settings.comment
          ? `SSH Key - ${settings.comment}`
          : `SSH Key (${settings.type.toUpperCase()})`
      );
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to generate key pair");
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
      toast.error(typeof err === "string" ? err : "Failed to save credential");
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

  const passphraseMismatch =
    settings.passphrase.length > 0 &&
    passConfirm.length > 0 &&
    settings.passphrase !== passConfirm;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
      onKeyDown={handleKeyDown}
    >
      <div className={`w-full bg-panel rounded-lg shadow-xl max-h-[90vh] overflow-y-auto transition-all duration-200 ${
        result ? "max-w-3xl" : "max-w-lg"
      }`}>
        {/* Header */}
        <div data-dialog-content className="flex items-center justify-between px-4 py-3 border-b border-stroke sticky top-0 bg-panel rounded-t-lg z-10">
          <h2 className="text-lg font-semibold text-ink">SSH Key Generator</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-raised rounded text-ink-muted hover:text-ink"
          >
            <CloseIcon size={20} />
          </button>
        </div>

        {/* Content — side-by-side when result exists */}
        <div className={`p-4 ${result ? "flex gap-4" : ""}`}>
          {/* Left: Settings panel */}
          <div className={`space-y-4 ${result ? "w-1/2 flex-shrink-0" : ""}`}>
            {/* Key type selector */}
            <div>
              <label className="block text-sm font-medium mb-1 text-ink-muted">
                Key Type
              </label>
              <div className="flex gap-1 p-1 bg-well rounded-lg">
                {keyTypes.map((kt) => (
                  <button
                    key={kt.value}
                    type="button"
                    onClick={() =>
                      setSettings((s) => ({ ...s, type: kt.value }))
                    }
                    className={`flex-1 py-1.5 px-3 text-sm rounded-md transition-colors ${
                      settings.type === kt.value
                        ? "bg-conduit-600 text-white"
                        : "hover:bg-raised text-ink-muted"
                    }`}
                  >
                    {kt.label}
                    {kt.value === "ed25519" && (
                      <span className="ml-1 text-[10px] opacity-60">recommended</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* RSA bits */}
            {settings.type === "rsa" && (
              <div>
                <label className="block text-sm font-medium mb-1 text-ink-muted">
                  Key Size
                </label>
                <div className="flex gap-1 p-1 bg-well rounded-lg">
                  {rsaBitsOptions.map((bits) => (
                    <button
                      key={bits}
                      type="button"
                      onClick={() =>
                        setSettings((s) => ({ ...s, rsaBits: bits }))
                      }
                      className={`flex-1 py-1.5 px-3 text-sm rounded-md transition-colors ${
                        settings.rsaBits === bits
                          ? "bg-conduit-600 text-white"
                          : "hover:bg-raised text-ink-muted"
                      }`}
                    >
                      {bits} bits
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ECDSA curve */}
            {settings.type === "ecdsa" && (
              <div>
                <label className="block text-sm font-medium mb-1 text-ink-muted">
                  Curve
                </label>
                <div className="flex gap-1 p-1 bg-well rounded-lg">
                  {ecdsaCurveOptions.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        setSettings((s) => ({ ...s, ecdsaCurve: opt.value }))
                      }
                      className={`flex-1 py-1.5 px-3 text-sm rounded-md transition-colors ${
                        settings.ecdsaCurve === opt.value
                          ? "bg-conduit-600 text-white"
                          : "hover:bg-raised text-ink-muted"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Passphrase */}
            <div>
              <label className="block text-sm font-medium mb-1 text-ink-muted">
                Passphrase <span className="text-ink-faint font-normal">(optional)</span>
              </label>
              <input
                type="password"
                value={settings.passphrase}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, passphrase: e.target.value }))
                }
                placeholder="Leave empty for no passphrase"
                className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-conduit-500"
              />
              {settings.passphrase && (
                <input
                  type="password"
                  value={passConfirm}
                  onChange={(e) => setPassConfirm(e.target.value)}
                  placeholder="Confirm passphrase"
                  className={`w-full mt-2 px-3 py-2 bg-well border rounded text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-conduit-500 ${
                    passphraseMismatch
                      ? "border-red-500/50"
                      : "border-stroke"
                  }`}
                />
              )}
              {passphraseMismatch && (
                <p className="text-xs text-red-400 mt-1">Passphrases do not match</p>
              )}
            </div>

            {/* Comment */}
            <div>
              <label className="block text-sm font-medium mb-1 text-ink-muted">
                Comment <span className="text-ink-faint font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={settings.comment}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, comment: e.target.value }))
                }
                placeholder="user@hostname"
                className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-conduit-500"
              />
            </div>

            {/* Generate button */}
            <button
              type="button"
              onClick={generate}
              disabled={generating || passphraseMismatch}
              className="w-full py-2.5 text-sm font-medium text-white bg-conduit-600 hover:bg-conduit-700 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors flex items-center justify-center gap-2"
            >
              {generating ? (
                <>
                  <LoaderIcon size={16} className="animate-spin" />
                  Generating...
                </>
              ) : result ? (
                "Regenerate Key Pair"
              ) : (
                "Generate Key Pair"
              )}
            </button>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}
          </div>

          {/* Right: Generated output */}
          {result && (
            <div className="w-1/2 flex-shrink-0 space-y-4 pl-4 border-l border-stroke">
              {/* Fingerprint */}
              <div>
                <label className="block text-sm font-medium mb-1.5 text-ink-muted">
                  Fingerprint
                </label>
                <code className="block px-3 py-2.5 bg-well border border-stroke rounded text-xs font-mono text-ink-secondary break-all">
                  {result.fingerprint}
                </code>
              </div>

              {/* Public key */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-ink-muted">
                    Public Key
                  </label>
                  <button
                    type="button"
                    onClick={handleCopyPublic}
                    className="flex items-center gap-1 px-2 py-0.5 text-xs text-ink-faint hover:text-conduit-400 transition-colors"
                    title="Copy public key"
                  >
                    <CopyIcon size={14} />
                    Copy
                  </button>
                </div>
                <textarea
                  readOnly
                  value={result.publicKey}
                  rows={3}
                  className="w-full px-3 py-2.5 bg-well border border-stroke rounded text-xs font-mono text-ink-secondary resize-none focus:outline-none"
                />
                <p className="text-[11px] text-ink-faint mt-1.5">
                  Add this to the server's <code className="text-ink-muted">~/.ssh/authorized_keys</code>
                </p>
              </div>

              {/* Private key */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-ink-muted">
                    Private Key
                  </label>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setShowPrivateKey(!showPrivateKey)}
                      className="p-0.5 text-ink-faint hover:text-conduit-400 transition-colors"
                      title={showPrivateKey ? "Hide" : "Show"}
                    >
                      {showPrivateKey ? (
                        <EyeOffIcon size={14} />
                      ) : (
                        <EyeIcon size={14} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={handleCopyPrivate}
                      className="flex items-center gap-1 px-2 py-0.5 text-xs text-ink-faint hover:text-conduit-400 transition-colors"
                      title="Copy private key"
                    >
                      <CopyIcon size={14} />
                      Copy
                    </button>
                  </div>
                </div>
                <div className="relative bg-well border border-stroke rounded overflow-hidden">
                  <textarea
                    readOnly
                    value={result.privateKey}
                    rows={6}
                    className="w-full px-3 py-2.5 bg-transparent text-xs font-mono text-ink-secondary resize-none focus:outline-none"
                    style={!showPrivateKey ? { color: 'transparent', textShadow: '0 0 8px var(--color-ink-muted)' } : undefined}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {result && (
          <div className="px-4 py-3 border-t border-stroke space-y-3">
            {/* Save to vault inline form */}
            {showSaveForm && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={credentialName}
                  onChange={(e) => setCredentialName(e.target.value)}
                  placeholder="Credential name..."
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveToVault();
                    if (e.key === "Escape") setShowSaveForm(false);
                  }}
                  className="flex-1 px-3 py-1.5 bg-well border border-stroke rounded text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-conduit-500"
                />
                <button
                  type="button"
                  onClick={handleSaveToVault}
                  disabled={!credentialName.trim() || saving}
                  className="px-3 py-1.5 text-sm text-white bg-conduit-600 hover:bg-conduit-700 disabled:opacity-50 rounded flex items-center gap-1.5"
                >
                  {saving ? (
                    <LoaderIcon size={14} className="animate-spin" />
                  ) : (
                    <FloppyIcon size={14} />
                  )}
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setShowSaveForm(false)}
                  className="px-3 py-1.5 text-sm text-ink-muted hover:text-ink rounded"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyInstallCommand}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm text-ink-secondary bg-raised hover:bg-raised/80 rounded transition-colors"
                  title="Copy a shell command that adds this public key to a server's authorized_keys"
                >
                  <TerminalAltIcon size={15} />
                  Copy Install Command
                </button>
                {isUnlocked && !showSaveForm && (
                  <button
                    type="button"
                    onClick={() => setShowSaveForm(true)}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm text-ink-secondary bg-raised hover:bg-raised/80 rounded transition-colors"
                  >
                    <FloppyIcon size={15} />
                    Save to Vault
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {onUseKey && (
                  <button
                    type="button"
                    onClick={handleUseKey}
                    className="px-4 py-2 text-sm text-white bg-conduit-600 hover:bg-conduit-700 rounded"
                  >
                    Use Private Key
                  </button>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    await handleCopyPublic();
                    onClose();
                  }}
                  className="px-4 py-2 text-sm text-ink-secondary bg-raised hover:bg-raised/80 rounded"
                >
                  Copy Public Key & Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer when no result yet */}
        {!result && (
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-stroke">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-ink-secondary bg-raised hover:bg-raised/80 rounded"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
