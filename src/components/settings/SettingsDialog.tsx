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
import AiToolsTab from "./tabs/AiToolsTab";
import BackupTab from "./tabs/BackupTab";
import MobileTab from "./tabs/MobileTab";
import SecurityTab from "./tabs/SecurityTab";
import TeamSettingsTab from "./TeamSettingsTab";
import AccountTab from "./tabs/AccountTab";
import type { Settings, SettingsTab } from "./SettingsHelpers";
import { HARDCODED_RDP_DEFAULTS, HARDCODED_WEB_DEFAULTS, HARDCODED_TERMINAL_DEFAULTS, HARDCODED_SSH_DEFAULTS } from "./SettingsHelpers";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useEntryStore } from "../../stores/entryStore";
import { CloseIcon } from "../../lib/icons";

export type { SettingsTab } from "./SettingsHelpers";

interface SettingsDialogProps {
  onClose: () => void;
  initialTab?: SettingsTab;
}

export default function SettingsDialog({ onClose, initialTab }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? "general");
  const [settings, setSettings] = useState<Settings>({
    theme: "system",
    color_scheme: DEFAULT_SCHEME,
    platform_theme: "default",
    default_shell: "default",
    ai_mode: "api",
    cli_agent: "claude",
    cli_font_size: 13,
    sidebar_mode: "pinned",
    default_engine: "claude-code",
    default_working_directory: null,
    terminal_mode: false,
    ui_scale: 1,
    default_web_engine: "auto",
    session_defaults_rdp: { ...HARDCODED_RDP_DEFAULTS },
    session_defaults_web: { ...HARDCODED_WEB_DEFAULTS },
    session_defaults_terminal: { ...HARDCODED_TERMINAL_DEFAULTS },
    session_defaults_ssh: { ...HARDCODED_SSH_DEFAULTS },
    tool_approval_enabled: true,
    tool_approval_always_allow: [],
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
      await invoke("settings_save", { settings });

      // Refresh the cached session defaults store
      await useSettingsStore.getState().refresh();

      // Apply theme + scheme
      document.dispatchEvent(
        new CustomEvent("conduit:theme-change", {
          detail: { theme: settings.theme, colorScheme: settings.color_scheme, platformTheme: settings.platform_theme },
        })
      );

      // Apply default engine setting to the store — only if it actually changed
      if (settings.default_engine && settings.default_engine !== originalSettingsRef.current?.default_engine) {
        useAiStore.getState().setActiveEngine(settings.default_engine);
      }

      // Apply terminal mode setting to the store — only if it actually changed
      if (settings.terminal_mode !== originalSettingsRef.current?.terminal_mode) {
        useAiStore.getState().setTerminalMode(settings.terminal_mode);
      }

      onClose();
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = useCallback(() => {
    // Revert live-previewed scheme to what it was on dialog open
    if (originalSettingsRef.current) {
      document.dispatchEvent(
        new CustomEvent("conduit:theme-change", {
          detail: {
            theme: originalSettingsRef.current.theme,
            colorScheme: originalSettingsRef.current.color_scheme,
            platformTheme: originalSettingsRef.current.platform_theme,
          },
        })
      );
      // Revert live-previewed UI scale
      window.electron?.send?.("set-zoom-factor", originalSettingsRef.current.ui_scale ?? 1);
    }
    onClose();
  }, [onClose]);

  /** Immediately save settings and reconnect active RDP sessions (used by display scale slider) */
  const handleApplyDisplayScale = useCallback(async (updatedSettings: Settings) => {
    setSettings(updatedSettings);
    try {
      await invoke("settings_save", { settings: updatedSettings });
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") handleCancel();
  };

  const renderTab = () => {
    switch (activeTab) {
      case "general":
        return <GeneralTab settings={settings} setSettings={setSettings} onClose={onClose} />;
      case "appearance":
        return <AppearanceTab settings={settings} setSettings={setSettings} onClose={onClose} />;
      case "security":
        return <SecurityTab />;
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
      case "ai/tools":
        return <AiToolsTab settings={settings} setSettings={setSettings} onClose={onClose} />;
      case "backup":
        return <BackupTab />;
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
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
      onKeyDown={handleKeyDown}
    >
      <div data-dialog-content className="w-full max-w-3xl bg-panel rounded-lg shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stroke">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button
            onClick={handleCancel}
            className="p-1 hover:bg-raised rounded"
          >
            <CloseIcon size={20} />
          </button>
        </div>

        <div className="flex h-[500px]">
          {/* Sidebar */}
          <SettingsNav activeTab={activeTab} onTabChange={setActiveTab} />

          {/* Content */}
          <div className="flex-1 p-4 overflow-y-auto">
            {renderTab()}

            {error && (
              <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-stroke">
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-sm hover:bg-raised rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-4 py-2 text-sm text-white bg-conduit-600 hover:bg-conduit-700 disabled:opacity-50 rounded"
          >
            {isSaving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
