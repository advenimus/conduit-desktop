import { useState, useEffect, useCallback, type CSSProperties } from "react";
import { invoke, listen } from "../../lib/electron";
import { KeyIcon } from "../../lib/icons";
import type { CredentialMeta, CredentialDto } from "../../types/credential";
import WindowToasts from "../common/WindowToasts";
import { IconButton, Spinner } from "../ui";
import PickerUnlock from "./PickerUnlock";
import PickerCredentialList from "./PickerCredentialList";
import PickerCredentialDetail from "./PickerCredentialDetail";

type View = "loading" | "unlock" | "list" | "detail";

const DRAG_REGION = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG_REGION = { WebkitAppRegion: "no-drag" } as CSSProperties;

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
    <div className="relative flex h-screen w-screen select-none flex-col overflow-hidden rounded-lg border border-overlay-border bg-overlay text-ink">
      <WindowToasts />
      {/* Draggable header */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-divider px-3" style={DRAG_REGION}>
        <div className="flex items-center gap-2 text-body font-semibold">
          <KeyIcon size={16} className="text-link" />
          Credential Picker
        </div>
        <IconButton icon="close" label="Close" onClick={handleClose} style={NO_DRAG_REGION} />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {view === "loading" && (
          <div className="flex h-full items-center justify-center">
            <Spinner size={24} className="text-link" />
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
