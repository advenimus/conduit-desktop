import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "../../lib/electron";
import { useAiStore } from "../../stores/aiStore";
import { DEFAULT_SCHEME } from "../../lib/schemes";
import SettingsNav from "./SettingsNav";
import GeneralTab from "./tabs/GeneralTab";
import AppearanceTab from "./tabs/AppearanceTab";
import SessionTerminalTab from "./tabs/SessionTerminalTab";
import SessionSshTab from "./tabs/SessionSshTab";
import SessionRdpTab from "./tabs/SessionRdpTab";
import SessionVncTab from "./tabs/SessionVncTab";
import SessionWebTab from "./tabs/SessionWebTab";
import AiTab from "./tabs/AiTab";
import BackupTab from "./tabs/BackupTab";
import MobileTab from "./tabs/MobileTab";
import SecurityTab from "./tabs/SecurityTab";
import SyncTab from "./tabs/SyncTab";
import TeamSettingsTab from "./TeamSettingsTab";
import AccountTab from "./tabs/AccountTab";
import type { Settings, SettingsTab } from "./SettingsHelpers";
import { HARDCODED_RDP_DEFAULTS, HARDCODED_WEB_DEFAULTS, HARDCODED_TERMINAL_DEFAULTS, HARDCODED_SSH_DEFAULTS } from "./SettingsHelpers";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useEntryStore } from "../../stores/entryStore";
import { DEFAULT_ICON_PACK } from "../../lib/icons";
import { Button, Callout, Dialog, DialogFooter, DialogHeader } from "../ui";
import type { ThemeChangeDetail } from "../../lib/appearance/useAppearance";
import { mergeChangedSettings } from "./settings-merge";
import { errorText } from "../../lib/errorText";

export type { SettingsTab } from "./SettingsHelpers";

/** Today's max-w-3xl (spec 4.8, D-18). */
const SETTINGS_WIDTH = 768;

interface SettingsDialogProps {
  onClose: () => void;
  initialTab?: SettingsTab;
}

function dispatchThemeChange(settings: Settings): void {
  const detail: ThemeChangeDetail = {
    theme: settings.theme,
    colorScheme: settings.color_scheme,
    iconPack: settings.icon_pack,
  };
  document.dispatchEvent(new CustomEvent("conduit:theme-change", { detail }));
}

async function saveChangedSettings(edited: Settings, original: Settings | null): Promise<void> {
  const fresh = await invoke<Settings>("settings_get");
  await invoke("settings_save", { settings: mergeChangedSettings(fresh, original, edited) });
}

// Only the RDP defaults: an icon pack, scheme or theme being previewed stays unsaved, so Cancel still reverts it.
async function saveRdpDefaults(rdp: Settings["session_defaults_rdp"]): Promise<void> {
  const fresh = await invoke<Settings>("settings_get");
  await invoke("settings_save", { settings: { ...fresh, session_defaults_rdp: rdp } });
}

export default function SettingsDialog({ onClose, initialTab }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? "general");
  const [settings, setSettings] = useState<Settings>({
    theme: "system",
    color_scheme: DEFAULT_SCHEME,
    icon_pack: DEFAULT_ICON_PACK,
    default_shell: "default",
    ai_mode: "api",
    cli_agent: "claude",
    cli_font_size: 13,
    default_engine: "claude-code",
    default_working_directory: null,
    ui_scale: 1,
    default_web_engine: "auto",
    session_defaults_rdp: { ...HARDCODED_RDP_DEFAULTS },
    session_defaults_web: { ...HARDCODED_WEB_DEFAULTS },
    session_defaults_terminal: { ...HARDCODED_TERMINAL_DEFAULTS },
    session_defaults_ssh: { ...HARDCODED_SSH_DEFAULTS },
    personal_sync_enabled: true,
    vault_idle_lock_minutes: 0,
  });
  const originalSettingsRef = useRef<Settings | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const loaded = await invoke<Settings>("settings_get");
        setSettings(loaded);
        originalSettingsRef.current = { ...loaded };
      } catch (err) {
        console.error("Failed to load settings:", err);
      }
    };
    loadSettings();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);

    try {
      await saveChangedSettings(settings, originalSettingsRef.current);

      // Refresh the cached session defaults store
      await useSettingsStore.getState().refresh();

      // Apply the saved appearance
      dispatchThemeChange(settings);

      // Apply default engine setting to the store — only if it actually changed
      if (settings.default_engine && settings.default_engine !== originalSettingsRef.current?.default_engine) {
        useAiStore.getState().setActiveEngine(settings.default_engine);
      }

      onClose();
    } catch (err) {
      setError(errorText(err, "Failed to save settings"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = useCallback(() => {
    // Revert live-previewed scheme to what it was on dialog open
    if (originalSettingsRef.current) {
      dispatchThemeChange(originalSettingsRef.current);
      // Revert live-previewed UI scale
      window.electron?.send?.("set-zoom-factor", originalSettingsRef.current.ui_scale ?? 1);
    }
    onClose();
  }, [onClose]);

  /** Immediately save the RDP display scale and reconnect active RDP sessions (used by display scale slider) */
  const handleApplyDisplayScale = useCallback(async (updatedSettings: Settings) => {
    setSettings(updatedSettings);
    const rdp = updatedSettings.session_defaults_rdp;
    try {
      await saveRdpDefaults(rdp);
      if (originalSettingsRef.current) originalSettingsRef.current = { ...originalSettingsRef.current, session_defaults_rdp: rdp };
      await useSettingsStore.getState().refresh();
      // Reconnect all active RDP sessions in the background
      const rdpSessions = useSessionStore.getState().sessions.filter(
        (s) => s.type === "rdp" && s.status === "connected" && s.entryId
      );
      for (const s of rdpSessions) {
        useEntryStore.getState().reconnectRdpSession(s.entryId!);
      }
    } catch (err) {
      console.error("Failed to apply display scale:", err);
    }
  }, []);

  const renderTab = () => {
    switch (activeTab) {
      case "general":
        return <GeneralTab settings={settings} setSettings={setSettings} onClose={onClose} onNavigate={setActiveTab} />;
      case "appearance":
        return <AppearanceTab settings={settings} setSettings={setSettings} onClose={onClose} />;
      case "security":
        return <SecurityTab settings={settings} setSettings={setSettings} onClose={onClose} />;
      case "sessions/terminal":
        return <SessionTerminalTab settings={settings} setSettings={setSettings} onClose={onClose} />;
      case "sessions/ssh":
        return <SessionSshTab settings={settings} setSettings={setSettings} onClose={onClose} />;
      case "sessions/rdp":
        return <SessionRdpTab settings={settings} setSettings={setSettings} onClose={onClose} onApplyDisplayScale={handleApplyDisplayScale} />;
      case "sessions/vnc":
        return <SessionVncTab />;
      case "sessions/web":
        return <SessionWebTab settings={settings} setSettings={setSettings} onClose={onClose} />;
      case "ai":
      case "ai/agent":
        return <AiTab settings={settings} setSettings={setSettings} onClose={onClose} />;
      case "backup":
        return <BackupTab />;
      case "sync":
        return <SyncTab />;
      case "mobile":
        return <MobileTab />;
      case "team":
        return <TeamSettingsTab />;
      case "account":
        return <AccountTab onClose={onClose} />;
      default:
        return null;
    }
  };

  return (
    <Dialog open onClose={handleCancel} title="Settings" width={SETTINGS_WIDTH} layout="custom" data-cv-settings="">
      <DialogHeader />
      <div className="flex h-[500px] min-h-0 border-y border-divider">
        <SettingsNav activeTab={activeTab} onTabChange={setActiveTab} />
        <div className="min-w-0 flex-1 overflow-y-auto p-4 text-body text-ink-secondary">
          {renderTab()}
          {error && (
            <Callout tone="danger" className="mt-4">
              {error}
            </Callout>
          )}
        </div>
      </div>
      <DialogFooter divided>
        <Button variant="secondary" onClick={handleCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSave} loading={isSaving} loadingLabel="Saving...">
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
