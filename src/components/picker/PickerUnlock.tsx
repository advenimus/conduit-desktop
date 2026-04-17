import { useState, useEffect, useRef } from "react";
import { invoke } from "../../lib/electron";

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
          setError(err instanceof Error ? err.message : "Failed to unlock team vault");
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
      await invoke("vault_unlock", { password });
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wrong password");
      setLoading(false);
    }
  };

  if (!vaultExists) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-4">
        <svg className="w-12 h-12 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
        </svg>
        <p className="text-sm text-ink-secondary">No vault configured</p>
        <button
          onClick={onShowMain}
          className="text-sm text-conduit-500 hover:text-conduit-400 transition-colors"
        >
          Open Conduit to set up a vault
        </button>
      </div>
    );
  }

  // Team vault: auto-unlock with spinner
  if (vaultType === "team") {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-4">
        {loading && !error ? (
          <>
            <div className="w-8 h-8 border-2 border-conduit-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-ink-secondary">Unlocking team vault...</p>
          </>
        ) : error ? (
          <>
            <svg className="w-12 h-12 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={onShowMain}
              className="text-sm text-conduit-500 hover:text-conduit-400 transition-colors"
            >
              Open Conduit
            </button>
          </>
        ) : null}
      </div>
    );
  }

  // Personal vault: password prompt
  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <svg className="w-12 h-12 text-ink-muted mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
      </svg>
      <p className="text-sm text-ink-secondary mb-4">Vault is locked</p>
      <form onSubmit={handleSubmit} className="w-full max-w-[260px] flex flex-col gap-3">
        <input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter master password..."
          className="w-full px-3 py-2 text-sm bg-well border border-stroke rounded-md text-ink placeholder:text-ink-faint focus:outline-none focus:border-conduit-500 focus:ring-1 focus:ring-conduit-500"
        />
        <button
          type="submit"
          disabled={loading || !password.trim()}
          className="w-full py-2 text-sm font-medium rounded-md bg-conduit-600 text-white hover:bg-conduit-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "Unlocking..." : "Unlock"}
        </button>
        {error && (
          <p className="text-xs text-red-400 text-center">{error}</p>
        )}
      </form>
    </div>
  );
}
