import { useSessionStore, type SessionType } from "../../stores/sessionStore";
import { useEntryStore } from "../../stores/entryStore";
import { friendlyConnectionError } from "../../lib/errorMessages";
import { PlugDisconnectedIcon } from "../../lib/icons";

interface ConnectionErrorProps {
  sessionId: string;
  entryId?: string;
  error: string | null;
  sessionType: SessionType;
}

export default function ConnectionError({ sessionId, entryId, error, sessionType }: ConnectionErrorProps) {
  const friendly = error ? friendlyConnectionError(error, sessionType) : "Disconnected";
  const showRaw = error && friendly !== error;

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-canvas text-ink-muted">
      <PlugDisconnectedIcon size={48} stroke={1.2} className="text-red-400 mb-4" />
      <div className="text-lg font-medium text-red-400 mb-2">Connection Error</div>
      <div className="text-sm text-ink-muted mb-1 max-w-md text-center">{friendly}</div>
      {showRaw && (
        <div className="text-xs text-ink-faint font-mono mt-1 max-w-md text-center break-all">{error}</div>
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
