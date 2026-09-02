import { useEffect, useState } from "react";
import { useSessionStore, type SessionType } from "../../stores/sessionStore";
import { useEntryStore } from "../../stores/entryStore";
import { friendlyConnectionError, localNetworkSettingsAppName } from "../../lib/errorMessages";
import { PlugDisconnectedIcon } from "../../lib/icons";
import { invoke } from "../../lib/electron";

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
  // only at the moment of asking — the user may fix it and come back.
  const [localNetworkBlocked, setLocalNetworkBlocked] = useState(false);
  useEffect(() => {
    if (!error) return;
    let active = true;
    invoke<string>("local_network_status")
      .then((status) => {
        if (active) setLocalNetworkBlocked(status === "denied");
      })
      .catch(() => {
        /* not macOS, or the probe could not run — leave the generic message */
      });
    return () => {
      active = false;
    };
  }, [error]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-canvas text-ink-muted">
      <PlugDisconnectedIcon size={48} stroke={1.2} className="text-red-400 mb-4" />
      <div className="text-lg font-medium text-red-400 mb-2">Connection Error</div>
      <div className="text-sm text-ink-muted mb-1 max-w-md text-center">{friendly}</div>
      {showRaw && (
        <div className="text-xs text-ink-faint font-mono mt-1 max-w-md text-center break-all">{error}</div>
      )}
      {localNetworkBlocked && (
        <div className="mt-4 max-w-md rounded-md border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-center">
          <div className="text-sm font-medium text-yellow-300 mb-1">
            macOS is blocking local network access
          </div>
          <div className="text-xs text-ink-secondary">
            {settingsAppName} cannot reach devices on your network until you allow it.
            Open Privacy &amp; Security, choose Local Network, and turn on {settingsAppName}.
          </div>
          <button
            onClick={() => invoke("open_local_network_settings").catch(console.error)}
            className="mt-3 px-3 py-1.5 bg-raised hover:bg-stroke-dim rounded-md text-xs font-medium transition-colors"
          >
            Open Settings
          </button>
        </div>
      )}
      <div className="flex gap-3 mt-6">
        {entryId && (
          <button
            onClick={() => useEntryStore.getState().reconnectSession(sessionId)}
            className="px-4 py-2 bg-conduit-600 hover:bg-conduit-700 text-white rounded-md text-sm font-medium transition-colors"
          >
            Reconnect
          </button>
        )}
        <button
          onClick={() => useSessionStore.getState().closeSession(sessionId)}
          className="px-4 py-2 bg-raised hover:bg-stroke-dim rounded-md text-sm font-medium transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}
