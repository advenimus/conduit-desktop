import { useState, useEffect, useCallback } from "react";
import { invoke, listen } from "../../lib/electron";
import type { CredentialMeta, CredentialDto } from "../../types/credential";
import { ToastContainer } from "../common/Toast";
import PickerUnlock from "./PickerUnlock";
import PickerCredentialList from "./PickerCredentialList";
import PickerCredentialDetail from "./PickerCredentialDetail";

type View = "loading" | "unlock" | "list" | "detail";

export default function CredentialPickerApp() {
  const [view, setView] = useState<View>("loading");
  const [credentials, setCredentials] = useState<CredentialMeta[]>([]);
  const [selectedCredential, setSelectedCredential] = useState<CredentialDto | null>(null);
  const [vaultType, setVaultType] = useState<"personal" | "team">("personal");
  const [vaultExists, setVaultExists] = useState(true);

  const loadCredentials = useCallback(async () => {
    try {
      const list = await invoke<CredentialMeta[]>("credential_list");
      setCredentials(list);
      setView("list");
    } catch {
      setView("unlock");
    }
  }, []);

  // Initial load: check vault status
  useEffect(() => {
    (async () => {
      try {
        const exists = await invoke<boolean>("vault_exists");
        if (!exists) {
          setVaultExists(false);
          setView("unlock");
          return;
        }
        const type = await invoke<string>("vault_get_type");
        setVaultType(type as "personal" | "team");
        const unlocked = await invoke<boolean>("vault_is_unlocked");
        if (unlocked) {
          await loadCredentials();
        } else {
          setView("unlock");
        }
      } catch {
        setView("unlock");
      }
    })();
  }, [loadCredentials]);

  // Listen for vault lock/unlock events from main app
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    listen("vault-unlocked", () => loadCredentials()).then((u) => unsubs.push(u));
    listen("vault-locked", () => {
      setCredentials([]);
      setSelectedCredential(null);
      setView("unlock");
    }).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, [loadCredentials]);

  // Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (view === "detail") {
          setSelectedCredential(null);
          setView("list");
        } else {
          invoke("picker_close");
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view]);

  const handleSelectCredential = async (id: string) => {
    try {
      const cred = await invoke<CredentialDto>("credential_get", { id });
      setSelectedCredential(cred);
      setView("detail");
    } catch {
      // ignore
    }
  };

  const handleBack = () => {
    setSelectedCredential(null);
    setView("list");
  };

  const handleUnlocked = () => {
    loadCredentials();
  };

  const handleClose = () => {
    invoke("picker_close");
  };

  const handleShowMain = () => {
    invoke("picker_show_main");
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-panel text-ink overflow-hidden rounded-lg border border-stroke select-none relative">
      {/* Toast Notifications */}
      <div className="fixed bottom-2 right-2 z-50 max-w-[280px]">
        <ToastContainer />
      </div>
      {/* Draggable header */}
      <div
        className="flex items-center justify-between px-3 h-11 border-b border-stroke shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <svg className="w-4 h-4 text-conduit-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
          </svg>
          Credential Picker
        </div>
        <button
          onClick={handleClose}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-well text-ink-muted hover:text-ink transition-colors"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {view === "loading" && (
          <div className="flex items-center justify-center h-full">
            <div className="w-5 h-5 border-2 border-conduit-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {view === "unlock" && (
          <PickerUnlock
            vaultType={vaultType}
            vaultExists={vaultExists}
            onUnlocked={handleUnlocked}
            onShowMain={handleShowMain}
          />
        )}
        {view === "list" && (
          <PickerCredentialList
            credentials={credentials}
            onSelect={handleSelectCredential}
          />
        )}
        {view === "detail" && selectedCredential && (
          <PickerCredentialDetail
            credential={selectedCredential}
            onBack={handleBack}
          />
        )}
      </div>
    </div>
  );
}
