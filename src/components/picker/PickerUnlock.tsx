import { useState, useEffect, useRef } from "react";
import { invoke } from "../../lib/electron";
import { AlertCircleIcon, LockIcon } from "../../lib/icons";
import { Button, Spinner, TextInput } from "../ui";
import { errorText } from "../../lib/errorText";

interface PickerUnlockProps {
  vaultType: "personal" | "team";
  vaultExists: boolean;
  onUnlocked: () => void;
  onShowMain: () => void;
}

export default function PickerUnlock({ vaultType, vaultExists, onUnlocked, onShowMain }: PickerUnlockProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus password input
  useEffect(() => {
    if (vaultExists && vaultType === "personal") {
      inputRef.current?.focus();
    }
  }, [vaultExists, vaultType]);

  // Team vault: auto-attempt unlock
  useEffect(() => {
    if (!vaultExists || vaultType !== "team") return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        await invoke("team_vault_open");
        if (!cancelled) onUnlocked();
      } catch (err) {
        if (!cancelled) {
          setError(errorText(err, "Failed to unlock team vault"));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [vaultType, vaultExists, onUnlocked]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setError(null);
    setLoading(true);
    try {
      await invoke("vault_unlock", { masterPassword: password });
      onUnlocked();
    } catch (err) {
      setError(errorText(err, "Wrong password"));
      setLoading(false);
    }
  };

  if (!vaultExists) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <LockIcon size={48} className="text-ink-muted" />
        <p className="text-body text-ink-secondary">No vault configured</p>
        <Button variant="link" size="lg" onClick={onShowMain}>
          Open Conduit to set up a vault
        </Button>
      </div>
    );
  }

  // Team vault: auto-unlock with spinner
  if (vaultType === "team") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        {loading && !error ? (
          <>
            <Spinner size={24} className="text-link" />
            <p className="text-body text-ink-secondary">Unlocking team vault...</p>
          </>
        ) : error ? (
          <>
            <AlertCircleIcon size={48} className="text-danger" />
            <p data-cv-error="" className="text-body text-danger">{error}</p>
            <Button variant="link" size="lg" onClick={onShowMain}>
              Open Conduit
            </Button>
          </>
        ) : null}
      </div>
    );
  }

  // Personal vault: password prompt
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <LockIcon size={48} className="mb-3 text-ink-muted" />
      <p className="mb-4 text-body text-ink-secondary">Vault is locked</p>
      <form onSubmit={handleSubmit} className="flex w-full max-w-[260px] flex-col gap-3">
        <TextInput
          ref={inputRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter master password..."
        />
        <Button
          type="submit"
          variant="primary"
          fullWidth
          disabled={!password.trim()}
          loading={loading}
          loadingLabel="Unlocking..."
        >
          Unlock
        </Button>
        {error && (
          <p data-cv-error="" className="text-center text-meta text-danger">{error}</p>
        )}
      </form>
    </div>
  );
}
