import { useState, useEffect } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import PasswordGenerateButton from "../tools/PasswordGenerateButton";
import SshKeyGenerateButton from "../tools/SshKeyGenerateButton";
import type { CredentialDto } from "../../types/credential";
import { CREDENTIAL_TYPES, resolveCredentialType, type CredentialType } from "../../types/credential";
import { toast } from "../common/Toast";
import { invoke } from "../../lib/electron";
import { generateTotpCode } from "../../lib/totp";
import {
  CloseIcon, CopyIcon, EyeIcon, EyeOffIcon, KeyboardIcon, PlusIcon, QrcodeIcon, ShieldLockIcon, TagIcon, TrashIcon
} from "../../lib/icons";

interface CredentialFormProps {
  editId?: string;
  presetType?: CredentialType;
  onClose: () => void;
  onSaved: () => void;
}

export default function CredentialForm({
  editId,
  presetType,
  onClose,
  onSaved,
}: CredentialFormProps) {
  const { createCredential, updateCredential, getCredential } = useVaultStore();

  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [domain, setDomain] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Credential type fields
  const [credentialType, setCredentialType] = useState<CredentialType>(presetType ?? "generic");
  const [publicKey, setPublicKey] = useState("");
  const [fingerprint, setFingerprint] = useState("");

  // SSH auth method preference
  const [sshAuthMethod, setSshAuthMethod] = useState<string | null>(null);

  // TOTP fields
  const [totpSecret, setTotpSecret] = useState("");
  const [totpIssuer, setTotpIssuer] = useState("");
  const [totpLabel, setTotpLabel] = useState("");
  const [totpAlgorithm, setTotpAlgorithm] = useState("SHA1");
  const [totpDigits, setTotpDigits] = useState(6);
  const [totpPeriod, setTotpPeriod] = useState(30);
  const [showTotpManual, setShowTotpManual] = useState(false);
  const [totpPreview, setTotpPreview] = useState<string | null>(null);

  const isEditing = !!editId;

  // Update TOTP preview when secret is configured
  useEffect(() => {
    if (!totpSecret) {
      setTotpPreview(null);
      return;
    }
    const update = () => {
      try {
        const result = generateTotpCode({
          secret: totpSecret,
          algorithm: totpAlgorithm,
          digits: totpDigits,
          period: totpPeriod,
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

  useEffect(() => {
    if (editId) {
      setIsFetching(true);
      getCredential(editId)
        .then((cred: CredentialDto) => {
          setName(cred.name);
          setUsername(cred.username || "");
          setPassword(cred.password || "");
          setDomain(cred.domain || "");
          setPrivateKey(cred.private_key || "");
          setTags(cred.tags);
          setCredentialType(resolveCredentialType(cred.credential_type));
          setPublicKey(cred.public_key || "");
          setFingerprint(cred.fingerprint || "");
          setTotpSecret(cred.totp_secret || "");
          setTotpIssuer(cred.totp_issuer || "");
          setTotpLabel(cred.totp_label || "");
          setTotpAlgorithm(cred.totp_algorithm || "SHA1");
          setTotpDigits(cred.totp_digits || 6);
          setTotpPeriod(cred.totp_period || 30);
          setSshAuthMethod(cred.ssh_auth_method ?? null);
        })
        .catch((err: unknown) => {
          setError(
            typeof err === "string" ? err : "Failed to load credential"
          );
        })
        .finally(() => setIsFetching(false));
    }
  }, [editId, getCredential]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setIsLoading(true);
    setError(null);

    try {
      if (isEditing) {
        await updateCredential(editId, {
          name: name.trim(),
          username: username.trim() || null,
          password: password || null,
          domain: domain.trim() || null,
          privateKey: privateKey || null,
          totpSecret: totpSecret || null,
          tags,
          credentialType: credentialType === "generic" ? undefined : credentialType,
          publicKey: publicKey || undefined,
          fingerprint: fingerprint || undefined,
          totpIssuer: totpSecret ? (totpIssuer || null) : null,
          totpLabel: totpSecret ? (totpLabel || null) : null,
          totpAlgorithm: totpSecret ? totpAlgorithm : null,
          totpDigits: totpSecret ? totpDigits : null,
          totpPeriod: totpSecret ? totpPeriod : null,
          sshAuthMethod: sshAuthMethod,
        });
      } else {
        await createCredential({
          name: name.trim(),
          username: username.trim() || undefined,
          password: password || undefined,
          domain: domain.trim() || undefined,
          privateKey: privateKey || undefined,
          totpSecret: totpSecret || undefined,
          tags,
          credentialType: credentialType === "generic" ? undefined : credentialType,
          publicKey: publicKey || undefined,
          fingerprint: fingerprint || undefined,
          totpIssuer: totpSecret ? (totpIssuer || null) : undefined,
          totpLabel: totpSecret ? (totpLabel || null) : undefined,
          totpAlgorithm: totpSecret ? totpAlgorithm : undefined,
          totpDigits: totpSecret ? totpDigits : undefined,
          totpPeriod: totpSecret ? totpPeriod : undefined,
          sshAuthMethod: sshAuthMethod || undefined,
        });
      }
      onSaved();
    } catch (err) {
      setError(
        typeof err === "string" ? err : "Failed to save credential"
      );
    } finally {
      setIsLoading(false);
    }
  };

  const addTag = () => {
    const tag = tagInput.trim();
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag]);
      setTagInput("");
    }
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
  };

  const handleTagKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

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
      setTotpSecret(result.secret);
      setTotpIssuer(result.issuer ?? "");
      setTotpLabel(result.label ?? "");
      setTotpAlgorithm(result.algorithm);
      setTotpDigits(result.digits);
      setTotpPeriod(result.period);
      setShowTotpManual(false);
      toast.success("QR code imported successfully");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to decode QR code");
    }
  };

  const handleRemoveTotp = () => {
    setTotpSecret("");
    setTotpIssuer("");
    setTotpLabel("");
    setTotpAlgorithm("SHA1");
    setTotpDigits(6);
    setTotpPeriod(30);
    setShowTotpManual(false);
  };

  const handleCopyPublicKey = async () => {
    if (publicKey) {
      await navigator.clipboard.writeText(publicKey);
      toast.success("Public key copied to clipboard");
    }
  };

  const credentialTypeEntries = Object.entries(CREDENTIAL_TYPES) as [CredentialType, { label: string; description: string }][];

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
      onKeyDown={handleKeyDown}
    >
      <div className="w-full max-w-md bg-panel rounded-lg shadow-xl max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-stroke sticky top-0 bg-panel rounded-t-lg">
            <h2 className="text-lg font-semibold">
              {isEditing
                ? "Edit Credential"
                : presetType && presetType !== "generic"
                  ? `New ${CREDENTIAL_TYPES[presetType].label} Credential`
                  : "New Credential"}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="p-1 hover:bg-raised rounded"
            >
              <CloseIcon size={20} />
            </button>
          </div>

          {isFetching ? (
            <div className="p-8 text-center text-ink-muted">Loading...</div>
          ) : (
            <>
              {/* Content */}
              <div className="p-4 space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder=""
                    autoFocus
                    className="w-full px-3 py-2 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
                  />
                </div>

                {/* Type selector */}
                <div>
                  <label className="block text-sm font-medium mb-1">Type</label>
                  <div className="flex gap-1 p-1 bg-well rounded-lg">
                    {credentialTypeEntries.map(([key, meta]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setCredentialType(key)}
                        className={`flex-1 py-1.5 px-3 text-sm rounded-md transition-colors ${
                          credentialType === key
                            ? "bg-conduit-600 text-white"
                            : "hover:bg-raised text-ink-muted"
                        }`}
                        title={meta.description}
                      >
                        {meta.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    Username
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder=""
                    className="w-full px-3 py-2 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder=""
                      className="w-full px-3 py-2 pr-16 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
                    />
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                      <PasswordGenerateButton onPasswordGenerated={setPassword} />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="p-1 text-ink-muted hover:text-ink"
                      >
                        {showPassword ? (
                          <EyeOffIcon size={16} />
                        ) : (
                          <EyeIcon size={16} />
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    Domain
                  </label>
                  <input
                    type="text"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder=""
                    className="w-full px-3 py-2 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
                  />
                </div>

                {/* TOTP section — shown for generic credentials only */}
                {credentialType !== "ssh_key" && (
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
                    ) : (
                      <>
                        {totpIssuer && (
                          <div className="text-xs text-ink-secondary">
                            <span className="text-ink-faint">Issuer:</span> {totpIssuer}
                            {totpLabel && <> &middot; <span className="text-ink-faint">Account:</span> {totpLabel}</>}
                          </div>
                        )}
                        <div className="text-xs text-ink-faint">
                          {totpAlgorithm} &middot; {totpDigits} digits &middot; {totpPeriod}s period
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

                    {showTotpManual && !totpSecret && (
                      <div className="space-y-2">
                        <div>
                          <label className="block text-xs font-medium mb-1 text-ink-secondary">Secret Key (Base32)</label>
                          <input
                            type="text"
                            value={totpSecret}
                            onChange={(e) => setTotpSecret(e.target.value.toUpperCase().replace(/\s/g, ""))}
                            placeholder=""
                            className="w-full px-3 py-1.5 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500 font-mono text-sm"
                          />
                        </div>
                        <div className="flex gap-2">
                          <div className="flex-1">
                            <label className="block text-xs font-medium mb-1 text-ink-secondary">Issuer</label>
                            <input
                              type="text"
                              value={totpIssuer}
                              onChange={(e) => setTotpIssuer(e.target.value)}
                              placeholder=""
                              className="w-full px-3 py-1.5 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500 text-sm"
                            />
                          </div>
                          <div className="flex-1">
                            <label className="block text-xs font-medium mb-1 text-ink-secondary">Account</label>
                            <input
                              type="text"
                              value={totpLabel}
                              onChange={(e) => setTotpLabel(e.target.value)}
                              placeholder=""
                              className="w-full px-3 py-1.5 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500 text-sm"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium mb-1">
                    Private Key
                  </label>
                  <div className="relative">
                    <textarea
                      value={privateKey}
                      onChange={(e) => setPrivateKey(e.target.value)}
                      placeholder=""
                      rows={3}
                      className={`w-full px-3 py-2 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500 font-mono text-xs resize-none ${
                        !showPrivateKey && privateKey ? "blur-sm select-none focus:blur-none focus:select-auto" : ""
                      }`}
                    />
                    <div className="absolute right-2 top-2 flex items-center gap-0.5">
                      <SshKeyGenerateButton
                        onKeyGenerated={setPrivateKey}
                        onFullKeyGenerated={(result) => {
                          setPrivateKey(result.privateKey);
                          setPublicKey(result.publicKey);
                          setFingerprint(result.fingerprint);
                          setCredentialType("ssh_key");
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPrivateKey(!showPrivateKey)}
                        className="p-1 text-ink-muted hover:text-ink"
                      >
                        {showPrivateKey ? (
                          <EyeOffIcon size={16} />
                        ) : (
                          <EyeIcon size={16} />
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {/* SSH Auth Method selector — shown when both private key and password are present */}
                {privateKey.trim() && password.trim() && (
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
                          onClick={() => setSshAuthMethod(opt.value)}
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

                {/* SSH Key Metadata section (shown when type is ssh_key) */}
                {credentialType === "ssh_key" && (
                  <div className="space-y-3 p-3 bg-well/50 border border-stroke/50 rounded-lg">
                    <p className="text-xs font-medium text-ink-muted uppercase tracking-wider">SSH Key Metadata</p>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-sm font-medium">Public Key</label>
                        {publicKey && (
                          <button
                            type="button"
                            onClick={handleCopyPublicKey}
                            className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-ink-faint hover:text-conduit-400 transition-colors"
                          >
                            <CopyIcon size={12} />
                            Copy
                          </button>
                        )}
                      </div>
                      <textarea
                        value={publicKey}
                        onChange={(e) => setPublicKey(e.target.value)}
                        placeholder=""
                        rows={2}
                        className="w-full px-3 py-2 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500 font-mono text-xs resize-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Fingerprint</label>
                      <input
                        type="text"
                        value={fingerprint}
                        readOnly
                        placeholder=""
                        className="w-full px-3 py-2 bg-well border border-stroke rounded font-mono text-xs text-ink-secondary cursor-default focus:outline-none"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium mb-1">Tags</label>
                  <div className="flex gap-2">
                    <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-well border border-stroke rounded">
                      <TagIcon size={16} className="text-ink-muted flex-shrink-0" />
                      <input
                        type="text"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={handleTagKeyDown}
                        placeholder=""
                        className="flex-1 bg-transparent text-sm outline-none"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={addTag}
                      disabled={!tagInput.trim()}
                      className="px-3 py-2 bg-raised hover:bg-raised disabled:opacity-50 rounded"
                    >
                      <PlusIcon size={16} />
                    </button>
                  </div>
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {tags.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-1 px-2 py-0.5 bg-conduit-600/20 text-conduit-300 text-xs rounded"
                        >
                          {tag}
                          <button
                            type="button"
                            onClick={() => removeTag(tag)}
                            className="hover:text-red-400"
                          >
                            <CloseIcon size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {error && (
                  <div className="p-3 bg-red-500/10 border border-red-500/20 rounded">
                    <p className="text-sm text-red-400">{error}</p>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex justify-end gap-2 px-4 py-3 border-t border-stroke">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm hover:bg-raised rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!name.trim() || isLoading}
                  className="px-4 py-2 text-sm text-white bg-conduit-600 hover:bg-conduit-700 disabled:opacity-50 disabled:cursor-not-allowed rounded"
                >
                  {isLoading
                    ? "Saving..."
                    : isEditing
                    ? "Save Changes"
                    : "Create"}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
