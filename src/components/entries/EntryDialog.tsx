import { useState, useEffect, useRef } from "react";
import { useEntryStore } from "../../stores/entryStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore } from "../../stores/teamStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { EntryType, RdpEntryConfig, WebEntryConfig, WebAutofillConfig, CommandEntryConfig } from "../../types/entry";
import { DEFAULT_COMMAND_CONFIG } from "../../types/entry";
import type { CredentialType } from "../../types/credential";
import { Button, Dialog, DialogFooter, DialogHeader } from "../ui";
import CredentialPicker from "../vault/CredentialPicker";
import EntryDialogSidebar from "./EntryDialogSidebar";
import EntryTypeStep, { type TypeOption } from "./EntryTypeStep";
import { VaultContextStrip, ViewOnlyNotice } from "./VaultContextStrip";
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
import EntryConflictInline from "../sync/EntryConflictInline";
import { announceResolvedBySave, conflictFieldsBeforeSave } from "../sync/editor-conflicts";
import { changedEditorFields } from "./entry-update-diff";

interface EntryDialogProps {
  onClose: () => void;
  presetType?: EntryType;
  folderId?: string | null;
  editingEntryId?: string | null;
}

const DEFAULT_PORTS: Record<string, number> = {
  ssh: 22,
  rdp: 3389,
  vnc: 5900,
};

export default function EntryDialog({ onClose, presetType, folderId, editingEntryId }: EntryDialogProps) {
  const { createEntry, getEntry, updateEntry } = useEntryStore();
  const { credentials, loadCredentials } = useVaultStore();
  const vaultType = useVaultStore((s) => s.vaultType);
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
  // What the editor showed after loading: a save sends only the fields that differ from it.
  const loadedFieldsRef = useRef<ReturnType<typeof editorFields> | null>(null);
  const captureLoadedRef = useRef(false);

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
      captureLoadedRef.current = true;
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

  const editorFields = () => ({
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
    config: buildConfig(),
    tags: tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    notes: notes.trim() || null,
    credential_type: credentialType ?? undefined,
  });

  useEffect(() => {
    if (!captureLoadedRef.current || isLoadingEntry) return;
    captureLoadedRef.current = false;
    loadedFieldsRef.current = editorFields();
  });

  const handleSubmit = async () => {
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
        const conflictedBefore = conflictFieldsBeforeSave(editingEntryId!);
        const updated = await updateEntry(editingEntryId!, changedEditorFields(loadedFieldsRef.current, editorFields()));
        // The store showed why; keep the dialog open so the edits are not lost.
        if (!updated) return;
        void announceResolvedBySave(editingEntryId!, conflictedBefore);
      } else {
        const created = await createEntry({
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
        if (!created) return;
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
      <Dialog open onClose={onClose} title="Edit Entry" width={448} hideClose closeOnEscape={false} layout="custom">
        <p className="p-8 text-center text-ink-muted">Loading entry...</p>
      </Dialog>
    );
  }

  const typeLabel = credentialType === "ssh_key" ? "SSH Key" : entryType === "document" ? "Document" : entryType === "command" ? "Command" : entryType?.toUpperCase();
  const title = step === "type" ? "New Entry" : `${isEditing ? "Edit" : "New"} ${typeLabel} Entry`;
  const showForm = step === "form" && entryType != null;

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
      <Dialog
        open
        onClose={onClose}
        title={title}
        width={showForm ? 768 : 448}
        closeOnEscape={false}
        layout="custom"
        onSubmit={showForm ? () => void handleSubmit() : undefined}
        className={showForm ? "min-h-[min(600px,80vh)]" : undefined}
        style={{ maxHeight: "80vh" }}
      >
        <DialogHeader />
        <VaultContextStrip />

        {isEditing && editingEntryId && vaultType === "personal" && (
          <EntryConflictInline entryId={editingEntryId} mode="editor" />
        )}

        {isViewerInTeamVault && <ViewOnlyNotice />}

        {step === "type" && <EntryTypeStep onSelect={selectType} />}

        {showForm && entryType && (
          <div className="flex min-h-0 flex-1">
            <EntryDialogSidebar
              entryType={entryType}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              credentialType={credentialType}
            />
            <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">{renderActiveTab()}</div>
          </div>
        )}

        {showForm && (
          <DialogFooter className="items-center border-t border-divider">
            {!presetType && !isEditing && (
              <Button onClick={() => setStep("type")} className="mr-auto">
                Back
              </Button>
            )}
            {validationError && (
              <p data-cv-error="" className="mr-2 text-meta text-danger">
                {validationError}
              </p>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!name.trim() || isViewerInTeamVault}
              loading={isSubmitting}
              loadingLabel={isEditing ? "Saving..." : "Creating..."}
            >
              {isEditing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        )}
      </Dialog>
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
