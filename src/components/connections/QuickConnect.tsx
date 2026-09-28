import { useState, useEffect } from "react";
import { invoke } from "../../lib/electron";
import { KeyIcon } from "../../lib/icons";
import { useSessionStore, SessionType } from "../../stores/sessionStore";
import PasswordGenerateButton from "../tools/PasswordGenerateButton";
import { useVaultStore } from "../../stores/vaultStore";
import { Button, Callout, Dialog, FormField, IconButton, SegmentedControl, Select, TextInput, type SegmentOption } from "../ui";
import { FULL_WIDTH_SEGMENTS } from "../tools/segments";

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

const typeOptions: ReadonlyArray<SegmentOption<ConnectionType>> = [
  { value: "ssh", icon: "terminal", label: "SSH" },
  { value: "rdp", icon: "desktop", label: "RDP" },
  { value: "vnc", icon: "serverAlt", label: "VNC" },
  { value: "web", icon: "globe", label: "Web" },
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

  const credentialLabel = (
    <span className="flex items-center gap-1.5">
      <KeyIcon size={14} />
      Stored Credential
    </span>
  );

  return (
    <Dialog
      open
      title="Quick Connect"
      onClose={onClose}
      width={448}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleConnect}
            disabled={(!host && type !== "web") || (type === "web" && !url)}
            loading={isLoading}
            loadingLabel="Connecting..."
          >
            Connect
          </Button>
        </>
      }
    >
      <SegmentedControl options={typeOptions} value={type} onChange={setType} className={FULL_WIDTH_SEGMENTS} />

      {type === "web" ? (
        <FormField label="URL">
          <TextInput type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" autoFocus />
        </FormField>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4">
            <FormField label="Host" className="col-span-2">
              <TextInput value={host} onChange={(e) => setHost(e.target.value)} placeholder="hostname or IP" autoFocus />
            </FormField>
            <FormField label="Port">
              <TextInput type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder={String(defaultPorts[type])} />
            </FormField>
          </div>

          {isUnlocked && credentials.length > 0 && (
            <FormField label={credentialLabel}>
              <Select
                value={selectedCredentialId}
                onChange={(e) => {
                  setSelectedCredentialId(e.target.value);
                  if (e.target.value) {
                    const cred = credentials.find((c) => c.id === e.target.value);
                    if (cred?.username) setUsername(cred.username);
                  }
                }}
              >
                <option value="">None (enter manually)</option>
                {credentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.username ? ` (${c.username})` : ""}
                  </option>
                ))}
              </Select>
            </FormField>
          )}

          {!selectedCredentialId && (
            <>
              <FormField label="Username">
                <TextInput value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
              </FormField>

              <FormField label="Password">
                <span className="relative block">
                  <TextInput
                    type={showPasswordField ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="password"
                    className="pr-12"
                  />
                  <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                    <PasswordGenerateButton onPasswordGenerated={setPassword} />
                    <IconButton
                      size="sm"
                      icon={showPasswordField ? "eyeOff" : "eye"}
                      label={showPasswordField ? "Hide password" : "Show password"}
                      onClick={() => setShowPasswordField(!showPasswordField)}
                    />
                  </span>
                </span>
              </FormField>
            </>
          )}
        </>
      )}

      {error && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}
