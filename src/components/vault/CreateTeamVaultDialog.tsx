import { useState, useEffect } from "react";
import { invoke } from "../../lib/electron";
import { useTeamStore } from "../../stores/teamStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useEntryStore } from "../../stores/entryStore";
import { useAuthStore } from "../../stores/authStore";
import RecoveryPassphraseDialog from "./RecoveryPassphraseDialog";
import {
  AlertCircleIcon, LoaderIcon, LockIcon, ShieldCheckIcon, UsersIcon
} from "../../lib/icons";

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-dialog-content className="bg-panel border border-stroke rounded-lg shadow-xl w-[440px] p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-conduit-500/10 flex items-center justify-center">
            <UsersIcon size={20} className="text-conduit-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-ink">
              Create Team Vault
            </h2>
            <p className="text-xs text-ink-muted">
              Shared, zero-knowledge encrypted
            </p>
          </div>
        </div>

        {/* Identity check loading */}
        {step === "identity-check" && (
          <div className="flex items-center justify-center py-8">
            <LoaderIcon size={24} className="text-conduit-400 animate-spin" />
          </div>
        )}

        {/* Generate identity key */}
        {step === "generate-key" && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-conduit-500/5 border border-conduit-500/20">
              <ShieldCheckIcon size={20} className="text-conduit-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm text-ink">Identity Key Required</p>
                <p className="text-xs text-ink-muted mt-1">
                  Team vaults use zero-knowledge encryption. You need an identity
                  key to encrypt and decrypt vault data. A recovery passphrase
                  will be generated for backup.
                </p>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20">
                <AlertCircleIcon size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-ink-muted hover:text-ink rounded-md hover:bg-raised transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateKey}
                disabled={loading}
                className="px-4 py-2 text-sm bg-conduit-600 text-white rounded-md hover:bg-conduit-500 transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {loading && <LoaderIcon size={14} className="animate-spin" />}
                Generate Identity Key
              </button>
            </div>
          </div>
        )}

        {/* Vault creation form */}
        {step === "form" && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1.5">
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Production Credentials"
                className="w-full px-3 py-2 rounded-md bg-well border border-stroke text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-conduit-500/50"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim()) handleCreate();
                }}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1.5">
                Description
                <span className="text-ink-faint ml-1">(optional)</span>
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of what this vault contains"
                className="w-full px-3 py-2 rounded-md bg-well border border-stroke text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-conduit-500/50"
              />
            </div>

            <div className="flex items-start gap-2 p-3 rounded-lg bg-well border border-stroke-dim">
              <LockIcon size={14} className="text-ink-faint mt-0.5 flex-shrink-0" />
              <p className="text-xs text-ink-muted">
                This vault will be encrypted with zero-knowledge keys. Only team
                members you add will have access.
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20">
                <AlertCircleIcon size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-ink-muted hover:text-ink rounded-md hover:bg-raised transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={loading || !name.trim()}
                className="px-4 py-2 text-sm bg-conduit-600 text-white rounded-md hover:bg-conduit-500 transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {loading && <LoaderIcon size={14} className="animate-spin" />}
                Create Vault
              </button>
            </div>
          </div>
        )}

        {/* Creating spinner */}
        {step === "creating" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <LoaderIcon size={32} className="text-conduit-400 animate-spin" />
            <p className="text-sm text-ink">Creating team vault...</p>
          </div>
        )}
      </div>
    </div>
  );
}
