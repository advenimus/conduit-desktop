import { useState, useEffect } from "react";
import { EyeIcon, EyeOffIcon, CopyIcon, ShieldLockIcon, QrcodeIcon, KeyboardIcon, TrashIcon, HistoryIcon } from "../../../lib/icons";
import type { EntryType } from "../../../types/entry";
import type { CredentialType } from "../../../types/credential";
import Field from "../Field";
import PasswordGenerateButton from "../../tools/PasswordGenerateButton";
import SshKeyGenerateButton from "../../tools/SshKeyGenerateButton";
import { toast } from "../../common/Toast";
import { invoke } from "../../../lib/electron";
import { generateTotpCode } from "../../../lib/totp";
import PasswordHistoryDialog from "../../vault/PasswordHistoryDialog";

interface CredentialsTabProps {
  entryType: EntryType;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  domain: string;
  setDomain: (v: string) => void;
  privateKey: string;
  setPrivateKey: (v: string) => void;
  credentialId: string | null;
  credentialName: string | null;
  onShowCredentialPicker: () => void;
  isConnection: boolean;
  isEditing: boolean;
  entryId?: string | null;
  entryName?: string;
  // Credential sub-type props (for entry_type === "credential")
  credentialType?: CredentialType | null;
  publicKey?: string;
  setPublicKey?: (v: string) => void;
  fingerprint?: string;
  setFingerprint?: (v: string) => void;
  onCredentialTypeChange?: (type: CredentialType) => void;
  // SSH auth method (for SSH entries or credentials with both key+password)
  sshAuthMethod?: string | null;
  onSshAuthMethodChange?: (method: string | null) => void;
  // Validation
  usernameRequired?: boolean;
  // TOTP props (for credential entries)
  totpSecret?: string;
  setTotpSecret?: (v: string) => void;
  totpIssuer?: string;
  setTotpIssuer?: (v: string) => void;
  totpLabel?: string;
  setTotpLabel?: (v: string) => void;
  totpAlgorithm?: string;
  setTotpAlgorithm?: (v: string) => void;
  totpDigits?: number;
  setTotpDigits?: (v: number) => void;
  totpPeriod?: number;
  setTotpPeriod?: (v: number) => void;
}

export default function CredentialsTab({
  entryType,
  username,
  setUsername,
  password,
  setPassword,
  domain,
  setDomain,
  privateKey,
  setPrivateKey,
  credentialId,
  credentialName,
  onShowCredentialPicker,
  isConnection,
  isEditing,
  entryId,
  entryName,
  credentialType,
  publicKey,
  setPublicKey,
  fingerprint,
  setFingerprint,
  onCredentialTypeChange,
  sshAuthMethod,
  onSshAuthMethodChange,
  usernameRequired,
  totpSecret,
  setTotpSecret,
  totpIssuer,
  setTotpIssuer,
  totpLabel,
  setTotpLabel,
  totpAlgorithm,
  setTotpAlgorithm,
  totpDigits,
  setTotpDigits,
  totpPeriod,
  setTotpPeriod,
}: CredentialsTabProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordHistory, setShowPasswordHistory] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [showTotpManual, setShowTotpManual] = useState(false);
  const [totpPreview, setTotpPreview] = useState<string | null>(null);

  const isSshKey = entryType === "credential" && credentialType === "ssh_key";
  const showTotpSection = !isSshKey && !!setTotpSecret;
  const showUsername = entryType !== "vnc";
  const showPrivateKeyField = entryType === "ssh" || entryType === "credential";
  const showDomain = entryType === "credential";

  const handleCopyPublicKey = async () => {
    if (publicKey) {
      await navigator.clipboard.writeText(publicKey);
      toast.success("Public key copied to clipboard");
    }
  };

  // TOTP preview code generation
  useEffect(() => {
    if (!totpSecret) {
      setTotpPreview(null);
      return;
    }
    const update = () => {
      try {
        const result = generateTotpCode({
          secret: totpSecret,
          algorithm: totpAlgorithm ?? "SHA1",
          digits: totpDigits ?? 6,
          period: totpPeriod ?? 30,
        });
        setTotpPreview(result.code);
      } catch {
        setTotpPreview(null);
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [totpSecret, totpAlgorithm, totpDigits, totpPeriod]);

  const handleImportQr = async () => {
    try {
      const filePath = await invoke<string | null>("totp_pick_qr_image");
      if (!filePath) return;
      const result = await invoke<{
        secret: string;
        issuer: string | null;
        label: string | null;
        algorithm: string;
        digits: number;
        period: number;
      }>("totp_decode_qr", { filePath });
      setTotpSecret?.(result.secret);
      setTotpIssuer?.(result.issuer ?? "");
      setTotpLabel?.(result.label ?? "");
      setTotpAlgorithm?.(result.algorithm);
      setTotpDigits?.(result.digits);
      setTotpPeriod?.(result.period);
      setShowTotpManual(false);
      toast.success("QR code imported successfully");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to decode QR code");
    }
  };

  const handleRemoveTotp = () => {
    setTotpSecret?.("");
    setTotpIssuer?.("");
    setTotpLabel?.("");
    setTotpAlgorithm?.("SHA1");
    setTotpDigits?.(6);
    setTotpPeriod?.(30);
    setShowTotpManual(false);
  };

  return (
    <div className="space-y-3">
      {/* Username (hidden for SSH Key credential type) */}
      {showUsername && !isSshKey && (
        <Field label={usernameRequired ? "Username *" : "Username"}>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder=""
            className={`w-full px-3 py-2 bg-well border rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500 ${
              usernameRequired && !username.trim() ? "border-red-500/50" : "border-stroke"
            }`}
          />
        </Field>
      )}

      {/* Password (hidden for SSH Key credential type) */}
      {!isSshKey && <Field label="Password">
        <div className="relative">
          <input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder=""
            className="w-full px-3 py-2 pr-16 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
            <PasswordGenerateButton onPasswordGenerated={setPassword} />
            {isEditing && entryId && (
              <button
                type="button"
                onClick={() => setShowPasswordHistory(true)}
                title="Password history"
                className="p-1 text-ink-faint hover:text-ink-secondary"
              >
                <HistoryIcon size={16} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="p-1 text-ink-faint hover:text-ink-secondary"
            >
              {showPassword ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
            </button>
          </div>
        </div>
      </Field>}

      {/* Domain (Credential type only, hidden for SSH Key) */}
      {showDomain && !isSshKey && (
        <Field label="Domain">
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder=""
            className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
          />
        </Field>
      )}

      {/* TOTP section — shown for generic credential entries only */}
      {showTotpSection && (
        <div className="space-y-3 p-3 bg-well/50 border border-stroke/50 rounded-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <ShieldLockIcon size={14} className="text-ink-muted" />
              <p className="text-xs font-medium text-ink-muted uppercase tracking-wider">One-Time Password (TOTP)</p>
            </div>
            {totpSecret && (
              <button
                type="button"
                onClick={handleRemoveTotp}
                className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-red-400 hover:text-red-300 transition-colors"
              >
                <TrashIcon size={12} />
                Remove
              </button>
            )}
          </div>

          {!totpSecret ? (
            <>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleImportQr}
                  className="flex-1 flex items-center justify-center gap-2 py-2 bg-well border border-stroke rounded hover:bg-raised transition-colors text-sm"
                >
                  <QrcodeIcon size={16} />
                  Import QR Code
                </button>
                <button
                  type="button"
                  onClick={() => setShowTotpManual(!showTotpManual)}
                  className="flex-1 flex items-center justify-center gap-2 py-2 bg-well border border-stroke rounded hover:bg-raised transition-colors text-sm"
                >
                  <KeyboardIcon size={16} />
                  Enter Secret Key
                </button>
              </div>
              {showTotpManual && (
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs font-medium mb-1 text-ink-secondary">Secret Key (Base32)</label>
                    <input
                      type="text"
                      value={totpSecret ?? ""}
                      onChange={(e) => setTotpSecret?.(e.target.value.toUpperCase().replace(/\s/g, ""))}
                      placeholder=""
                      className="w-full px-3 py-1.5 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500 font-mono text-sm"
                    />
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="block text-xs font-medium mb-1 text-ink-secondary">Issuer</label>
                      <input
                        type="text"
                        value={totpIssuer ?? ""}
                        onChange={(e) => setTotpIssuer?.(e.target.value)}
                        placeholder=""
                        className="w-full px-3 py-1.5 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500 text-sm"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs font-medium mb-1 text-ink-secondary">Account</label>
                      <input
                        type="text"
                        value={totpLabel ?? ""}
                        onChange={(e) => setTotpLabel?.(e.target.value)}
                        placeholder=""
                        className="w-full px-3 py-1.5 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500 text-sm"
                      />
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              {totpIssuer && (
                <div className="text-xs text-ink-secondary">
                  <span className="text-ink-faint">Issuer:</span> {totpIssuer}
                  {totpLabel && <> &middot; <span className="text-ink-faint">Account:</span> {totpLabel}</>}
                </div>
              )}
              <div className="text-xs text-ink-faint">
                {totpAlgorithm ?? "SHA1"} &middot; {totpDigits ?? 6} digits &middot; {totpPeriod ?? 30}s period
              </div>
              {totpPreview && (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-lg text-conduit-400 tracking-widest">
                    {totpPreview.slice(0, Math.ceil(totpPreview.length / 2))}{" "}
                    {totpPreview.slice(Math.ceil(totpPreview.length / 2))}
                  </span>
                  <span className="text-xs text-green-400">Preview</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Private Key */}
      {showPrivateKeyField && (
        <Field label="Private Key">
          <div className="relative">
            <textarea
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder=""
              rows={3}
              className={`w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500 resize-none font-mono text-xs ${
                !showPrivateKey && privateKey ? "blur-sm select-none focus:blur-none focus:select-auto" : ""
              }`}
            />
            <div className="absolute right-2 top-2 flex items-center gap-0.5">
              <SshKeyGenerateButton
                onKeyGenerated={setPrivateKey}
                onFullKeyGenerated={(result) => {
                  setPrivateKey(result.privateKey);
                  setPublicKey?.(result.publicKey);
                  setFingerprint?.(result.fingerprint);
                  onCredentialTypeChange?.("ssh_key");
                }}
              />
              <button
                type="button"
                onClick={() => setShowPrivateKey(!showPrivateKey)}
                className="p-1 text-ink-faint hover:text-ink-secondary"
              >
                {showPrivateKey ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
              </button>
            </div>
          </div>
        </Field>
      )}

      {/* SSH Auth Method selector — shown for SSH entries when both key and password are present */}
      {(entryType === "ssh" || entryType === "credential") && privateKey.trim() && password.trim() && onSshAuthMethodChange && (
        <div className="space-y-3 p-3 bg-well/50 border border-stroke/50 rounded-lg">
          <p className="text-xs font-medium text-ink-muted uppercase tracking-wider">SSH Authentication</p>
          <div className="flex gap-1 p-1 bg-well rounded-lg">
            {[
              { value: null, label: "Default" },
              { value: "key", label: "SSH Key" },
              { value: "password", label: "Password" },
            ].map((opt) => (
              <button
                key={opt.value ?? "default"}
                type="button"
                onClick={() => onSshAuthMethodChange(opt.value)}
                className={`flex-1 py-1.5 px-3 text-sm rounded-md transition-colors ${
                  sshAuthMethod === opt.value
                    ? "bg-conduit-600 text-white"
                    : "hover:bg-raised text-ink-muted"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-muted">
            Choose which method to use when connecting. &ldquo;Default&rdquo; uses the global setting from Settings.
          </p>
        </div>
      )}

      {/* SSH Key Metadata (SSH Key credential type only) */}
      {isSshKey && setPublicKey && (
        <div className="space-y-3 p-3 bg-well/50 border border-stroke/50 rounded-lg">
          <p className="text-xs font-medium text-ink-muted uppercase tracking-wider">SSH Key Metadata</p>
          <Field label="Public Key">
            <div className="relative">
              <textarea
                value={publicKey ?? ""}
                onChange={(e) => setPublicKey(e.target.value)}
                placeholder=""
                rows={2}
                className="w-full px-3 py-2 pr-10 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500 font-mono text-xs resize-none"
              />
              {publicKey && (
                <button
                  type="button"
                  onClick={handleCopyPublicKey}
                  className="absolute right-2 top-2 p-1 text-ink-faint hover:text-conduit-400"
                  title="Copy public key"
                >
                  <CopyIcon size={14} />
                </button>
              )}
            </div>
          </Field>
          <Field label="Fingerprint">
            <input
              type="text"
              value={fingerprint ?? ""}
              readOnly
              placeholder=""
              className="w-full px-3 py-2 bg-well border border-stroke rounded font-mono text-xs text-ink-secondary cursor-default focus:outline-none"
            />
          </Field>
        </div>
      )}

      {/* Linked Credential */}
      {isConnection && (
        <Field label="Linked Credential">
          <button
            type="button"
            onClick={onShowCredentialPicker}
            className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm text-left focus:outline-none focus:ring-2 focus:ring-conduit-500 hover:border-stroke-dim transition-colors"
          >
            {credentialId
              ? credentialName ?? "Unknown credential"
              : <span className="text-ink-faint">None (use inline credentials)</span>}
          </button>
        </Field>
      )}
      {showPasswordHistory && entryId && (
        <PasswordHistoryDialog
          entryId={entryId}
          entryName={entryName ?? "Entry"}
          onClose={() => setShowPasswordHistory(false)}
        />
      )}
    </div>
  );
}
