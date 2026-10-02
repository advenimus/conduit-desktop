import { useEffect, useState } from "react";
import { useSessionStore, type SessionType } from "../../stores/sessionStore";
import { useEntryStore } from "../../stores/entryStore";
import { friendlyConnectionError, localNetworkSettingsAppName, mayBeLocalNetworkBlock } from "../../lib/errorMessages";
import { PlugDisconnectedIcon } from "../../lib/icons";
import { invoke } from "../../lib/electron";
import { Button, Callout } from "../ui";
import { SessionStatePanel } from "./SessionStates";

interface ConnectionErrorProps {
  sessionId: string;
  entryId?: string;
  error: string | null;
  sessionType: SessionType;
}

export default function ConnectionError({ sessionId, entryId, error, sessionType }: ConnectionErrorProps) {
  const friendly = error ? friendlyConnectionError(error, sessionType) : "Disconnected";
  const showRaw = error && friendly !== error;
  const settingsAppName = localNetworkSettingsAppName();

  // macOS can block LAN traffic app-wide, which surfaces here as an ordinary
  // unreachable-host error. Only the main process can tell the difference, and
  // only at the moment of asking; the user may fix it and come back.
  // Sign-in failures, refusals and timeouts are never a macOS block, so only
  // unreachable-host errors ask.
  const mayBeBlocked = error ? mayBeLocalNetworkBlock(error) : false;
  const [localNetworkBlocked, setLocalNetworkBlocked] = useState(false);
  useEffect(() => {
    if (!error || !mayBeBlocked) return;
    let active = true;
    invoke<string>("local_network_status")
      .then((status) => {
        if (active) setLocalNetworkBlocked(status === "denied");
      })
      .catch(() => {
        /* not macOS, or the probe could not run: leave the generic message */
      });
    return () => {
      active = false;
    };
  }, [error, mayBeBlocked]);

  return (
    <SessionStatePanel className="flex-1">
      <PlugDisconnectedIcon size={48} stroke={1.2} className="mb-4 text-danger" />
      <div className="mb-2 text-title font-medium text-danger">Connection Error</div>
      <div className="mb-1 max-w-md text-center text-body text-ink-muted">{friendly}</div>
      {showRaw && <div className="mt-1 max-w-md break-all text-center font-mono text-label text-ink-faint">{error}</div>}
      {mayBeBlocked && localNetworkBlocked && (
        <Callout
          tone="warning"
          className="mt-4 max-w-md"
          title="macOS is blocking local network access"
          actions={
            <Button size="sm" onClick={() => invoke("open_local_network_settings").catch(console.error)}>
              Open Settings
            </Button>
          }
        >
          {settingsAppName} cannot reach devices on your network until you allow it.
          Open Privacy &amp; Security, choose Local Network, and turn on {settingsAppName}.
        </Callout>
      )}
      <div className="mt-6 flex gap-3">
        {entryId && (
          <Button variant="primary" onClick={() => useEntryStore.getState().reconnectSession(sessionId)}>
            Reconnect
          </Button>
        )}
        <Button onClick={() => useSessionStore.getState().closeSession(sessionId)}>Close</Button>
      </div>
    </SessionStatePanel>
  );
}
