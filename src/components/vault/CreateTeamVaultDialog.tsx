import { useState, useEffect } from "react";
import { invoke } from "../../lib/electron";
import { useTeamStore } from "../../stores/teamStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useEntryStore } from "../../stores/entryStore";
import { useAuthStore } from "../../stores/authStore";
import RecoveryPassphraseDialog from "./RecoveryPassphraseDialog";
import { LockIcon } from "../../lib/icons";
import { Button, Callout, Dialog, FormField, Spinner, TextInput } from "../ui";

interface CreateTeamVaultDialogProps {
  onClose: () => void;
}

type Step = "identity-check" | "generate-key" | "show-passphrase" | "form" | "creating";

export default function CreateTeamVaultDialog({
  onClose,
}: CreateTeamVaultDialogProps) {
  const [step, setStep] = useState<Step>("identity-check");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [passphrase, setPassphrase] = useState<string | null>(null);

  const { teamId: authTeamId } = useAuthStore();
  const { team } = useTeamStore();
  const teamId = authTeamId ?? team?.id ?? null;

  // Check identity key on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const exists = await invoke<boolean>("identity_key_exists");
        if (cancelled) return;
        setStep(exists ? "form" : "generate-key");
      } catch {
        if (!cancelled) setStep("generate-key");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleGenerateKey = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<{ recoveryPassphrase: string }>("identity_key_generate");
      setPassphrase(result.recoveryPassphrase);
      setStep("show-passphrase");
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to generate identity key");
    } finally {
      setLoading(false);
    }
  };

  const handlePassphraseSaved = () => {
    setPassphrase(null);
    setStep("form");
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    if (!teamId) {
      setError("No team found. Please ensure you are a member of a team.");
      return;
    }

    setLoading(true);
    setError(null);
    setStep("creating");
    try {
      const result = await invoke<{ id: string }>("team_vault_create", {
        name: name.trim(),
        teamId,
        description: description.trim() || null,
      });
      await useTeamStore.getState().loadTeamVaults();
      await useVaultStore.getState().openTeamVault(result.id);
      await useEntryStore.getState().loadAll();
      onClose();
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to create team vault");
      setStep("form");
    } finally {
      setLoading(false);
    }
  };

  // Recovery passphrase display
  if (step === "show-passphrase" && passphrase) {
    return (
      <RecoveryPassphraseDialog
        passphrase={passphrase}
        onConfirm={handlePassphraseSaved}
      />
    );
  }

  const footer =
    step === "generate-key" ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={handleGenerateKey} loading={loading}>
          Generate Identity Key
        </Button>
      </>
    ) : step === "form" ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={handleCreate} disabled={!name.trim()} loading={loading}>
          Create Vault
        </Button>
      </>
    ) : undefined;

  return (
    <Dialog
      open
      title="Create Team Vault"
      icon="users"
      width={440}
      hideClose
      closeOnEscape={false}
      onClose={onClose}
      footer={footer}
    >
      <p className="-mt-2 pl-9 text-label text-ink-muted">Shared, zero-knowledge encrypted</p>

      {step === "identity-check" && (
        <div className="flex items-center justify-center py-8">
          <Spinner size={24} className="text-ink-muted" />
        </div>
      )}

      {step === "generate-key" && (
        <>
          <Callout tone="info" icon="shieldCheck" title="Identity Key Required">
            Team vaults use zero-knowledge encryption. You need an identity
            key to encrypt and decrypt vault data. A recovery passphrase
            will be generated for backup.
          </Callout>
          {error && <Callout tone="danger">{error}</Callout>}
        </>
      )}

      {step === "form" && (
        <>
          <FormField label="Name">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production Credentials"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) handleCreate();
              }}
            />
          </FormField>

          <FormField
            label={
              <>
                Description
                <span className="ml-1 font-normal text-ink-faint">(optional)</span>
              </>
            }
          >
            <TextInput
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of what this vault contains"
            />
          </FormField>

          <div className="flex items-start gap-2 rounded-md border border-card-border bg-well p-2.5">
            <LockIcon size={16} className="mt-px shrink-0 text-ink-faint" />
            <p className="text-label text-ink-muted">
              This vault will be encrypted with zero-knowledge keys. Only team
              members you add will have access.
            </p>
          </div>

          {error && <Callout tone="danger">{error}</Callout>}
        </>
      )}

      {step === "creating" && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Spinner size={24} className="text-ink-muted" />
          <p className="text-body text-ink">Creating team vault...</p>
        </div>
      )}
    </Dialog>
  );
}
