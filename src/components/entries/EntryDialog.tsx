import { useState, useEffect, useRef } from "react";
import {
  CloseIcon,
  TerminalIcon,
  DesktopIcon,
  ServerAltIcon,
  GlobeIcon,
  KeyIcon,
  UsersIcon,
  LockIcon,
  ShieldLockIcon,
  FileTextIcon,
  PlayerPlayIcon,
} from "../../lib/icons";
import type { IconComponent } from "../../lib/icons";
import { useEntryStore } from "../../stores/entryStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore } from "../../stores/teamStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { EntryType, RdpEntryConfig, WebEntryConfig, WebAutofillConfig, CommandEntryConfig } from "../../types/entry";
import { DEFAULT_COMMAND_CONFIG } from "../../types/entry";
import type { CredentialType } from "../../types/credential";
import CredentialPicker from "../vault/CredentialPicker";
import EntryDialogSidebar from "./EntryDialogSidebar";
import type { EntryTabId } from "./entryDialogTabs";
import { getDefaultTabId } from "./entryDialogTabs";
import GeneralTab from "./tabs/GeneralTab";
import CredentialsTab from "./tabs/CredentialsTab";
import DisplayTab from "./tabs/DisplayTab";
import ResourcesTab from "./tabs/ResourcesTab";
import SecurityTab from "./tabs/SecurityTab";
import AutofillTab from "./tabs/AutofillTab";
import InformationTab from "./tabs/InformationTab";
import CommandTab from "./tabs/CommandTab";

interface EntryDialogProps {
  onClose: () => void;
  presetType?: EntryType;
  folderId?: string | null;
  editingEntryId?: string | null;
}

interface TypeOption {
  type: EntryType;
  label: string;
  description: string;
  icon: IconComponent;
  color: string;
  /** If set, triggers a special action instead of opening the normal entry form */
  credentialType?: CredentialType;
}

interface TypeCategory {
  label: string;
  items: TypeOption[];
}

const ENTRY_TYPE_CATEGORIES: TypeCategory[] = [
  {
    label: "Connections",
    items: [
      { type: "ssh", label: "SSH", description: "Terminal", icon: TerminalIcon, color: "text-green-400 border-green-400/30 hover:bg-green-400/10" },
      { type: "rdp", label: "RDP", description: "Remote Desktop", icon: DesktopIcon, color: "text-blue-400 border-blue-400/30 hover:bg-blue-400/10" },
      { type: "vnc", label: "VNC", description: "Screen Share", icon: ServerAltIcon, color: "text-purple-400 border-purple-400/30 hover:bg-purple-400/10" },
      { type: "web", label: "Web", description: "Browser Session", icon: GlobeIcon, color: "text-cyan-400 border-cyan-400/30 hover:bg-cyan-400/10" },
    ],
  },
  {
    label: "Documents",
    items: [
      { type: "document", label: "Document", description: "Markdown", icon: FileTextIcon, color: "text-teal-400 border-teal-400/30 hover:bg-teal-400/10" },
    ],
  },
  {
    label: "Automation",
    items: [
      { type: "command", label: "Command", description: "Run As User", icon: PlayerPlayIcon, color: "text-amber-400 border-amber-400/30 hover:bg-amber-400/10" },
    ],
  },
  {
    label: "Credentials",
    items: [
      { type: "credential", label: "Password", description: "Username & password", icon: KeyIcon, color: "text-yellow-400 border-yellow-400/30 hover:bg-yellow-400/10", credentialType: "generic" },
      { type: "credential", label: "SSH Key", description: "Key pair & fingerprint", icon: ShieldLockIcon, color: "text-orange-400 border-orange-400/30 hover:bg-orange-400/10", credentialType: "ssh_key" },
    ],
  },
];

const DEFAULT_PORTS: Record<string, number> = {
  ssh: 22,
  rdp: 3389,
  vnc: 5900,
};

export default function EntryDialog({ onClose, presetType, folderId, editingEntryId }: EntryDialogProps) {
  const { createEntry, getEntry, updateEntry } = useEntryStore();
  const { credentials, loadCredentials } = useVaultStore();
  const vaultType = useVaultStore((s) => s.vaultType);
  const teamVaultId = useVaultStore((s) => s.teamVaultId);
  const teamVaults = useTeamStore((s) => s.teamVaults);
  const teamVaultName = teamVaults.find((v) => v.id === teamVaultId)?.name;
  const currentVaultPath = useVaultStore((s) => s.currentVaultPath);
  const getEffectiveRole = useTeamStore((s) => s.getEffectiveRole);
  const entries = useEntryStore((s) => s.entries);

  // Compute the effective role for the target folder
  const effectiveFolderId = folderId ?? (editingEntryId ? entries.find(e => e.id === editingEntryId)?.folder_id : null);
  const isViewerInTeamVault = vaultType === "team" && getEffectiveRole(effectiveFolderId ?? undefined) === "viewer";

  const [showCredentialPicker, setShowCredentialPicker] = useState(false);

  const isEditing = !!editingEntryId;
  const [step, setStep] = useState<"type" | "form">(presetType || isEditing ? "form" : "type");
  const [entryType, setEntryType] = useState<EntryType | null>(presetType ?? null);
  const [isLoadingEntry, setIsLoadingEntry] = useState(false);
  const [activeTab, setActiveTab] = useState<EntryTabId>(getDefaultTabId());

  // Form fields
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [domain, setDomain] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  const [customIcon, setCustomIcon] = useState<string | null>(null);
  const [customColor, setCustomColor] = useState<string | null>(null);
  const [rdpConfig, setRdpConfig] = useState<Partial<RdpEntryConfig>>({});
  const [webConfig, setWebConfig] = useState<Partial<WebEntryConfig>>({});
  const [autofillConfig, setAutofillConfig] = useState<Partial<WebAutofillConfig>>({});
  const rdpGlobalDefaults = useSettingsStore((s) => s.sessionDefaultsRdp);
  const webGlobalDefaults = useSettingsStore((s) => s.sessionDefaultsWeb);
  const [commandConfig, setCommandConfig] = useState<CommandEntryConfig>({ ...DEFAULT_COMMAND_CONFIG });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Credential sub-type fields (for entry_type === "credential")
  const [credentialType, setCredentialType] = useState<CredentialType | null>(null);
  const [publicKey, setPublicKey] = useState("");
  const [fingerprint, setFingerprint] = useState("");

  // SSH auth method (for SSH entries or credentials with both key+password)
  const [sshAuthMethod, setSshAuthMethod] = useState<string | null>(null);

  // TOTP fields (for credential entries)
  const [totpSecret, setTotpSecret] = useState("");
  const [totpIssuer, setTotpIssuer] = useState("");
  const [totpLabel, setTotpLabel] = useState("");
  const [totpAlgorithm, setTotpAlgorithm] = useState("SHA1");
  const [totpDigits, setTotpDigits] = useState(6);
  const [totpPeriod, setTotpPeriod] = useState(30);

  // Keep a ref to onClose so the load effect can call it without re-firing
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Load entry data when editing
  useEffect(() => {
    if (!editingEntryId) return;
    setIsLoadingEntry(true);
    getEntry(editingEntryId).then((entry) => {
      setEntryType(entry.entry_type);
      setName(entry.name);
      setHost(entry.host ?? "");
      setPort(entry.port != null ? String(entry.port) : "");
      setCredentialId(entry.credential_id ?? null);
      setUsername(entry.username ?? "");
      setPassword(entry.password ?? "");
      setDomain(entry.domain ?? "");
      setPrivateKey(entry.private_key ?? "");
      setCustomIcon(entry.icon ?? null);
      setCustomColor(entry.color ?? null);
      setTags(Array.isArray(entry.tags) ? entry.tags.join(", ") : "");
      setNotes(entry.notes ?? "");
      if (entry.credential_type) {
        setCredentialType(entry.credential_type as CredentialType);
      }
      if (entry.entry_type === "credential" && entry.config) {
        const cfg = entry.config as Record<string, unknown>;
        if (cfg.public_key) setPublicKey(cfg.public_key as string);
        if (cfg.fingerprint) setFingerprint(cfg.fingerprint as string);
      }
      // Load SSH auth method from config
      if (entry.config) {
        const cfg = entry.config as Record<string, unknown>;
        if (cfg.ssh_auth_method) setSshAuthMethod(cfg.ssh_auth_method as string);
      }
      // Load TOTP fields for any entry type
      if (entry.totp_secret) {
        setTotpSecret(entry.totp_secret);
      }
      if (entry.config) {
        const cfg = entry.config as Record<string, unknown>;
        if (cfg.totp_issuer) setTotpIssuer(cfg.totp_issuer as string);
        if (cfg.totp_label) setTotpLabel(cfg.totp_label as string);
        if (cfg.totp_algorithm) setTotpAlgorithm(cfg.totp_algorithm as string);
        if (cfg.totp_digits) setTotpDigits(cfg.totp_digits as number);
        if (cfg.totp_period) setTotpPeriod(cfg.totp_period as number);
      }
      if (entry.entry_type === "command" && entry.config) {
        setCommandConfig({ ...DEFAULT_COMMAND_CONFIG, ...entry.config as Partial<CommandEntryConfig> });
      }
      if (entry.entry_type === "rdp" && entry.config) {
        // Load raw config — undefined fields show as "Default" in the UI
        setRdpConfig(entry.config as Partial<RdpEntryConfig>);
      }
      if (entry.entry_type === "web" && entry.config) {
        const wc = entry.config as Partial<WebEntryConfig>;
        setWebConfig(wc);
        if (wc.autofill) {
          setAutofillConfig(wc.autofill);
        }
      }
      setStep("form");
      setIsLoadingEntry(false);
    }).catch((err) => {
      console.error("Failed to load entry for editing:", err);
      setIsLoadingEntry(false);
      onCloseRef.current();
    });
  }, [editingEntryId, getEntry]);

  // Refresh credentials on mount
  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  const selectType = (option: TypeOption) => {
    setEntryType(option.type);
    if (option.credentialType) {
      setCredentialType(option.credentialType);
    }
    if (option.type in DEFAULT_PORTS) {
      setPort(String(DEFAULT_PORTS[option.type]));
    }
    setActiveTab(getDefaultTabId());
    setStep("form");
  };

  /** Build TOTP metadata fields to merge into any config */
  const buildTotpMeta = (): Record<string, unknown> => {
    if (!totpSecret) return {};
    const meta: Record<string, unknown> = {};
    if (totpIssuer) meta.totp_issuer = totpIssuer;
    if (totpLabel) meta.totp_label = totpLabel;
    meta.totp_algorithm = totpAlgorithm;
    meta.totp_digits = totpDigits;
    meta.totp_period = totpPeriod;
    return meta;
  };

  const buildConfig = (): Record<string, unknown> | undefined => {
    const totpMeta = buildTotpMeta();

    // Strip undefined values from a record so they're not stored
    const stripUndefined = (obj: Record<string, unknown>): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined) {
          result[key] = value;
        }
      }
      return result;
    };

    if (entryType === "command") {
      return { ...commandConfig as unknown as Record<string, unknown>, ...totpMeta };
    }
    if (entryType === "rdp") {
      return { ...stripUndefined(rdpConfig as unknown as Record<string, unknown>), ...totpMeta };
    }
    if (entryType === "web") {
      // Include autofill only if any field was explicitly set
      const autofillStripped = stripUndefined(autofillConfig as unknown as Record<string, unknown>);
      const hasAutofill = Object.keys(autofillStripped).length > 0;
      const merged = {
        ...stripUndefined(webConfig as unknown as Record<string, unknown>),
        ...(hasAutofill ? { autofill: autofillStripped } : {}),
      };
      return { ...merged, ...totpMeta };
    }
    if (entryType === "document") {
      return { content: "", ...totpMeta };
    }
    // Store credential metadata (non-secret) in config JSON
    if (entryType === "credential") {
      const config: Record<string, unknown> = {};
      if (credentialType === "ssh_key") {
        if (publicKey) config.public_key = publicKey;
        if (fingerprint) config.fingerprint = fingerprint;
      }
      if (sshAuthMethod) config.ssh_auth_method = sshAuthMethod;
      Object.assign(config, totpMeta);
      if (Object.keys(config).length > 0) return config;
    }
    // SSH entries: store ssh_auth_method in config
    if (entryType === "ssh") {
      const config: Record<string, unknown> = {};
      if (sshAuthMethod) config.ssh_auth_method = sshAuthMethod;
      Object.assign(config, totpMeta);
      if (Object.keys(config).length > 0) return config;
      return undefined;
    }
    // Other types with only TOTP
    if (Object.keys(totpMeta).length > 0) return totpMeta;
    return undefined;
  };

  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!entryType || !name.trim()) return;

    // SSH entries require a username (unless a linked credential provides one)
    if (entryType === 'ssh' && !username.trim() && !credentialId) {
      setValidationError('Username is required for SSH connections');
      setActiveTab('credentials');
      return;
    }
    setValidationError(null);

    setIsSubmitting(true);
    const config = buildConfig();
    try {
      if (isEditing) {
        await updateEntry(editingEntryId!, {
          name: name.trim(),
          host: host.trim() || null,
          port: port ? parseInt(port, 10) : null,
          credential_id: credentialId,
          username: username.trim() || null,
          password: password || null,
          domain: domain.trim() || null,
          private_key: privateKey || null,
          totp_secret: totpSecret || null,
          icon: customIcon,
          color: customColor,
          config,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          notes: notes.trim() || null,
          credential_type: credentialType ?? undefined,
        });
      } else {
        await createEntry({
          name: name.trim(),
          entry_type: entryType,
          folder_id: folderId,
          host: host.trim() || null,
          port: port ? parseInt(port, 10) : null,
          credential_id: credentialId,
          username: username.trim() || null,
          password: password || null,
          domain: domain.trim() || null,
          private_key: privateKey || null,
          totp_secret: totpSecret || null,
          icon: customIcon,
          color: customColor,
          config,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          notes: notes.trim() || null,
          credential_type: credentialType ?? undefined,
        });
      }

      // Auto-reconnect if this RDP entry has an active session
      if (isEditing && entryType === "rdp" && editingEntryId) {
        const session = useSessionStore.getState().sessions.find(
          (s) => s.entryId === editingEntryId && s.type === "rdp"
        );
        if (session) {
          setTimeout(() => {
            useEntryStore.getState().reconnectRdpSession(editingEntryId);
          }, 100);
        }
      }

      onClose();
    } catch (err) {
      console.error(`Failed to ${isEditing ? "update" : "create"} entry:`, err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isConnection = entryType != null && entryType !== "credential" && entryType !== "document";
  const credentialName = credentialId
    ? credentials.find((c) => c.id === credentialId)?.name ?? null
    : null;

  if (isLoadingEntry) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50">
        <div data-dialog-content className="w-full max-w-md bg-panel rounded-lg shadow-xl p-8 text-center">
          <p className="text-ink-muted">Loading entry...</p>
        </div>
      </div>
    );
  }

  const renderActiveTab = () => {
    if (!entryType) return null;

    switch (activeTab) {
      case "general":
        return (
          <GeneralTab
            entryType={entryType}
            name={name}
            setName={setName}
            host={host}
            setHost={setHost}
            port={port}
            setPort={setPort}
            domain={domain}
            setDomain={setDomain}
            customIcon={customIcon}
            setCustomIcon={setCustomIcon}
            customColor={customColor}
            setCustomColor={setCustomColor}
          />
        );
      case "credentials":
        return (
          <CredentialsTab
            entryType={entryType}
            username={username}
            setUsername={(v) => { setUsername(v); setValidationError(null); }}
            password={password}
            setPassword={setPassword}
            domain={domain}
            setDomain={setDomain}
            privateKey={privateKey}
            setPrivateKey={setPrivateKey}
            credentialId={credentialId}
            credentialName={credentialName}
            onShowCredentialPicker={() => setShowCredentialPicker(true)}
            isConnection={isConnection}
            isEditing={isEditing}
            entryId={editingEntryId}
            entryName={name}
            credentialType={credentialType}
            publicKey={publicKey}
            setPublicKey={setPublicKey}
            fingerprint={fingerprint}
            setFingerprint={setFingerprint}
            onCredentialTypeChange={setCredentialType}
            sshAuthMethod={sshAuthMethod}
            onSshAuthMethodChange={setSshAuthMethod}
            usernameRequired={entryType === 'ssh' && !credentialId}
            totpSecret={totpSecret}
            setTotpSecret={setTotpSecret}
            totpIssuer={totpIssuer}
            setTotpIssuer={setTotpIssuer}
            totpLabel={totpLabel}
            setTotpLabel={setTotpLabel}
            totpAlgorithm={totpAlgorithm}
            setTotpAlgorithm={setTotpAlgorithm}
            totpDigits={totpDigits}
            setTotpDigits={setTotpDigits}
            totpPeriod={totpPeriod}
            setTotpPeriod={setTotpPeriod}
          />
        );
      case "display":
        return (
          <DisplayTab
            config={rdpConfig}
            onChange={setRdpConfig}
            globalDefaults={rdpGlobalDefaults}
          />
        );
      case "resources":
        return (
          <ResourcesTab
            config={rdpConfig}
            onChange={setRdpConfig}
            globalDefaults={rdpGlobalDefaults}
          />
        );
      case "security":
        return (
          <SecurityTab
            entryType={entryType}
            rdpConfig={rdpConfig}
            onRdpConfigChange={setRdpConfig}
            webConfig={webConfig}
            onWebConfigChange={setWebConfig}
            host={host}
            rdpGlobalDefaults={rdpGlobalDefaults}
            webGlobalDefaults={webGlobalDefaults}
          />
        );
      case "autofill":
        return (
          <AutofillTab
            config={autofillConfig}
            onChange={setAutofillConfig}
            globalDefaults={webGlobalDefaults}
          />
        );
      case "command":
        return (
          <CommandTab
            config={commandConfig}
            onChange={setCommandConfig}
          />
        );
      case "information":
        return (
          <InformationTab
            tags={tags}
            setTags={setTags}
            notes={notes}
            setNotes={setNotes}
          />
        );
      default:
        return null;
    }
  };

  return (
    <>
      <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50">
        <div data-dialog-content className={`w-full ${step === "form" ? "max-w-3xl min-h-[min(600px,80vh)]" : "max-w-md"} bg-panel rounded-lg shadow-xl max-h-[80vh] flex flex-col`}>
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-stroke">
            <h2 className="text-lg font-semibold">
              {step === "type"
                ? "New Entry"
                : isEditing
                  ? `Edit ${credentialType === "ssh_key" ? "SSH Key" : entryType === "document" ? "Document" : entryType === "command" ? "Command" : entryType?.toUpperCase()} Entry`
                  : `New ${credentialType === "ssh_key" ? "SSH Key" : entryType === "document" ? "Document" : entryType === "command" ? "Command" : entryType?.toUpperCase()} Entry`}
            </h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-raised">
              <CloseIcon size={18} />
            </button>
          </div>

          {/* Vault context */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-stroke text-xs">
            {vaultType === "team" ? (
              <>
                <UsersIcon size={14} className="text-conduit-400" />
                <span className="text-ink-muted">Saving to:</span>
                <span className="text-ink font-medium">{teamVaultName ?? "Team Vault"}</span>
                <span className="px-1.5 py-0.5 bg-conduit-500/10 text-conduit-400 rounded text-[10px]">Team</span>
              </>
            ) : (
              <>
                <LockIcon size={14} className="text-ink-faint" />
                <span className="text-ink-muted">Saving to:</span>
                <span className="text-ink font-medium">{currentVaultPath?.split(/[/\\]/).pop() ?? "Personal Vault"}</span>
              </>
            )}
          </div>

          {/* Viewer warning */}
          {isViewerInTeamVault && (
            <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-400">
              <LockIcon size={14} />
              <span>You have view-only access to this folder</span>
            </div>
          )}

          {/* Step 1: Type selection */}
          {step === "type" && (
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
              {ENTRY_TYPE_CATEGORIES.map((category) => (
                <div key={category.label}>
                  <p className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-2 px-0.5">
                    {category.label}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {category.items.map((option) => {
                      const TypeIcon = option.icon;
                      return (
                        <button
                          key={`${option.type}-${option.credentialType ?? ''}`}
                          onClick={() => selectType(option)}
                          className={`flex items-center gap-2 px-3 py-2 border rounded-lg transition-colors ${option.color}`}
                        >
                          <TypeIcon size={16} />
                          <span className="text-xs font-medium whitespace-nowrap">{option.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Step 2: Sidebar + Tab Content */}
          {step === "form" && entryType && (
            <form onSubmit={handleSubmit} className="flex-1 flex flex-col min-h-0">
              <div className="flex flex-1 min-h-0">
                <EntryDialogSidebar
                  entryType={entryType}
                  activeTab={activeTab}
                  onTabChange={setActiveTab}
                  credentialType={credentialType}
                />
                <div className="flex-1 p-5 overflow-y-auto">
                  {renderActiveTab()}
                </div>
              </div>

              {/* Footer */}
              <div className="flex justify-between px-4 py-3 border-t border-stroke flex-shrink-0">
                <div>
                  {!presetType && !isEditing && (
                    <button
                      type="button"
                      onClick={() => setStep("type")}
                      className="px-4 py-2 text-sm hover:bg-raised rounded"
                    >
                      Back
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {validationError && (
                    <p className="text-xs text-red-400 mr-2">{validationError}</p>
                  )}
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-sm hover:bg-raised rounded"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!name.trim() || isSubmitting || isViewerInTeamVault}
                    className="px-4 py-2 text-sm text-white bg-conduit-600 hover:bg-conduit-700 disabled:opacity-50 disabled:cursor-not-allowed rounded"
                  >
                    {isSubmitting
                      ? isEditing ? "Saving..." : "Creating..."
                      : isEditing ? "Save" : "Create"}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
      {showCredentialPicker && (
        <CredentialPicker
          selectedId={credentialId}
          onSelect={setCredentialId}
          onClose={() => setShowCredentialPicker(false)}
        />
      )}
    </>
  );
}
