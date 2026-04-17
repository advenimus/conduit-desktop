import { useState, useEffect } from "react";
import { invoke } from "../../lib/electron";
import { CloseIcon, TerminalIcon, DesktopIcon, ServerAltIcon, GlobeIcon, KeyIcon, EyeIcon, EyeOffIcon } from "../../lib/icons";
import type { IconComponent } from "../../lib/icons";
import { useSessionStore, SessionType } from "../../stores/sessionStore";
import PasswordGenerateButton from "../tools/PasswordGenerateButton";
import { useVaultStore } from "../../stores/vaultStore";

interface QuickConnectProps {
  onClose: () => void;
}

type ConnectionType = "ssh" | "rdp" | "vnc" | "web";

const defaultPorts: Record<ConnectionType, number> = {
  ssh: 22,
  rdp: 3389,
  vnc: 5900,
  web: 443,
};

const typeButtons: {
  type: ConnectionType;
  icon: IconComponent;
  label: string;
}[] = [
  { type: "ssh", icon: TerminalIcon, label: "SSH" },
  { type: "rdp", icon: DesktopIcon, label: "RDP" },
  { type: "vnc", icon: ServerAltIcon, label: "VNC" },
  { type: "web", icon: GlobeIcon, label: "Web" },
];

export default function QuickConnect({ onClose }: QuickConnectProps) {
  const [type, setType] = useState<ConnectionType>("ssh");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [url, setUrl] = useState("");
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>("");
  const [showPasswordField, setShowPasswordField] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addSession = useSessionStore((s) => s.addSession);
  const { credentials, isUnlocked, loadCredentials } = useVaultStore();

  useEffect(() => {
    if (isUnlocked) {
      loadCredentials();
    }
  }, [isUnlocked, loadCredentials]);

  const handleConnect = async () => {
    setError(null);
    setIsLoading(true);

    try {
      let sessionId: string;

      if (type === "web") {
        sessionId = await invoke<string>("web_session_create", {
          url,
        });
      } else {
        const resolvedPort = parseInt(port) || defaultPorts[type];

        if (type === "ssh") {
          sessionId = await invoke<string>("ssh_session_create", {
            host,
            port: resolvedPort,
            credentialId: selectedCredentialId || null,
            username: !selectedCredentialId ? username || null : null,
            password: !selectedCredentialId ? password || null : null,
          });
        } else if (type === "rdp") {
          sessionId = crypto.randomUUID();

          // Measure content area for dynamic resolution
          const contentEl = document.querySelector('[data-content-area]');
          let w = contentEl?.clientWidth ?? (window.innerWidth - 250);
          let h = contentEl?.clientHeight ?? (window.innerHeight - 40);
          w = Math.max(800, w - (w % 2));
          h = Math.max(600, h - (h % 2));

          // Add session instantly in "connecting" state
          addSession({
            id: sessionId,
            type: "rdp",
            title: host,
            status: "connecting",
          });
          setIsLoading(false);
          onClose();

          // Connect in background
          invoke<{ sessionId: string; width: number; height: number; mode: string }>("rdp_connect", {
            sessionId,
            host,
            port: resolvedPort,
            username: username || "",
            password: password || "",
            width: w,
            height: h,
          }).then((result) => {
            useSessionStore.getState().addSession({
              id: sessionId,
              type: "rdp",
              title: host,
              status: "connected",
              metadata: {
                rdpWidth: result.width,
                rdpHeight: result.height,
                rdpMode: result.mode,
              },
            });
          }).catch((err) => {
            const msg = typeof err === "string" ? err : err instanceof Error ? err.message : "Connection failed";
            useSessionStore.getState().updateSessionStatus(sessionId, "disconnected", msg);
          });
          return;
        } else if (type === "vnc") {
          sessionId = crypto.randomUUID();
          await invoke("vnc_connect", {
            sessionId,
            host,
            port: resolvedPort,
            password: password || "",
          });
        } else {
          throw new Error(`Unsupported connection type: ${type}`);
        }
      }

      addSession({
        id: sessionId,
        type: type as SessionType,
        title: type === "web" ? url : `${host}`,
        status: "connected",
      });

      onClose();
    } catch (err) {
      setError(
        typeof err === "string" ? err : err instanceof Error ? err.message : "Connection failed"
      );
    } finally {
      setIsLoading(false);
    }
  };

  // Close on Escape key
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
      onKeyDown={handleKeyDown}
    >
      <div data-dialog-content className="w-full max-w-md max-h-[80vh] flex flex-col bg-panel rounded-lg shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stroke">
          <h2 className="text-lg font-semibold">Quick Connect</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-raised rounded"
          >
            <CloseIcon size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {/* Type selector */}
          <div className="flex gap-2">
            {typeButtons.map(({ type: t, icon: Icon, label }) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded ${
                  type === t
                    ? "bg-conduit-600 text-white"
                    : "bg-raised hover:bg-raised"
                }`}
              >
                <Icon size={16} />
                <span className="text-sm">{label}</span>
              </button>
            ))}
          </div>

          {/* Form fields */}
          {type === "web" ? (
            <div>
              <label className="block text-sm font-medium mb-1">URL</label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                autoFocus
                className="w-full px-3 py-2 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm font-medium mb-1">Host</label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="hostname or IP"
                    autoFocus
                    className="w-full px-3 py-2 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Port</label>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder={String(defaultPorts[type])}
                    className="w-full px-3 py-2 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
                  />
                </div>
              </div>

              {/* Credential selector */}
              {isUnlocked && credentials.length > 0 && (
                <div>
                  <label className="block text-sm font-medium mb-1">
                    <span className="flex items-center gap-1.5">
                      <KeyIcon size={14} />
                      Stored Credential
                    </span>
                  </label>
                  <select
                    value={selectedCredentialId}
                    onChange={(e) => {
                      setSelectedCredentialId(e.target.value);
                      if (e.target.value) {
                        const cred = credentials.find((c) => c.id === e.target.value);
                        if (cred?.username) setUsername(cred.username);
                      }
                    }}
                    className="w-full px-3 py-2 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
                  >
                    <option value="">None (enter manually)</option>
                    {credentials.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}{c.username ? ` (${c.username})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {!selectedCredentialId && (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      Username
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="username"
                      className="w-full px-3 py-2 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">
                      Password
                    </label>
                    <div className="relative">
                      <input
                        type={showPasswordField ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="password"
                        className="w-full px-3 py-2 pr-16 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
                      />
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                        <PasswordGenerateButton onPasswordGenerated={setPassword} />
                        <button
                          type="button"
                          onClick={() => setShowPasswordField(!showPasswordField)}
                          className="p-1 text-ink-faint hover:text-conduit-400"
                        >
                          {showPasswordField ? (
                            <EyeOffIcon size={16} />
                          ) : (
                            <EyeIcon size={16} />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-stroke">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm hover:bg-raised rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleConnect}
            disabled={
              isLoading || (!host && type !== "web") || (type === "web" && !url)
            }
            className="px-4 py-2 text-sm text-white bg-conduit-600 hover:bg-conduit-700 disabled:opacity-50 disabled:cursor-not-allowed rounded"
          >
            {isLoading ? "Connecting..." : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
