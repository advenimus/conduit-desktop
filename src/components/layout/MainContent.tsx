import { useSessionStore } from "../../stores/sessionStore";
import { useEntryStore } from "../../stores/entryStore";
import { TerminalView, RdpView, VncView, WebView, DocumentView, CommandView, ConnectionError } from "../sessions";
import EntryDashboard from "../dashboard/EntryDashboard";
import FolderDashboard from "../dashboard/FolderDashboard";
import DashboardOverview from "../dashboard/DashboardOverview";

export default function MainContent() {
  const { sessions, activeSessionId } = useSessionStore();
  const { entries, folders, selectedEntryId } = useEntryStore();

  // Render session view for a given session
  const renderSessionView = (session: (typeof sessions)[number]) => {
    const isActive = session.id === activeSessionId;

    // Show connecting spinner for sessions still being established
    // (RDP handles its own connecting UI internally, documents are always "connected")
    if (session.status === "connecting" && session.type !== "rdp" && session.type !== "document" && session.type !== "command" && session.type !== "dashboard") {
      return (
        <div className="flex-1 flex flex-col items-center justify-center bg-canvas text-ink-muted">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ink-muted mb-4" />
          <p className="text-sm">Connecting to {session.title}...</p>
        </div>
      );
    }

    // Show error overlay for disconnected non-RDP sessions (RDP handles its own, documents don't disconnect)
    if (session.status === "disconnected" && session.type !== "rdp" && session.type !== "document" && session.type !== "command" && session.type !== "dashboard") {
      return (
        <ConnectionError
          sessionId={session.id}
          entryId={session.entryId}
          error={session.error ?? null}
          sessionType={session.type}
        />
      );
    }

    switch (session.type) {
      case "local_shell":
      case "ssh":
        return (
          <TerminalView
            sessionId={session.id}
            isActive={isActive}
            onTitleChange={(title) => {
              useSessionStore
                .getState()
                .updateSessionTitle(session.id, title);
            }}
          />
        );
      case "rdp":
        return (
          <RdpView
            sessionId={session.id}
            entryId={session.entryId}
            isActive={isActive}
            width={(session.metadata?.rdpWidth as number) || 1920}
            height={(session.metadata?.rdpHeight as number) || 1080}
            rdpMode={session.metadata?.rdpMode as string | undefined}
            enableHighDpi={session.metadata?.enableHighDpi as boolean | undefined}
            enableClipboard={session.metadata?.enableClipboard as boolean | undefined}
            status={session.status}
            connectionError={session.error}
            onClose={() => {
              useSessionStore.getState().closeSession(session.id);
            }}
          />
        );
      case "vnc":
        return (
          <VncView
            sessionId={session.id}
            isActive={isActive}
            onClose={() => {
              useSessionStore.getState().closeSession(session.id);
            }}
          />
        );
      case "web":
        return <WebView sessionId={session.id} entryId={session.entryId} isActive={isActive} />;
      case "document":
        return <DocumentView entryId={session.entryId!} isActive={isActive} />;
      case "command":
        return <CommandView sessionId={session.id} entryId={session.entryId!} isActive={isActive} />;
      case "dashboard":
        return session.entryId
          ? <EntryDashboard entryId={session.entryId} />
          : <DashboardOverview />;
      default:
        return (
          <p className="text-ink-faint">
            Unsupported session type: {session.type}
          </p>
        );
    }
  };

  // Priority 1: Active session tab -> show session views
  if (sessions.length > 0) {
    return (
      <>
        {sessions.map((session) => (
          <div
            key={session.id}
            className="h-full w-full"
            style={{
              display: session.id === activeSessionId ? "flex" : "none",
            }}
          >
            {renderSessionView(session)}
          </div>
        ))}
      </>
    );
  }

  // Priority 2: Selected entry/folder, no active session -> show dashboard
  if (selectedEntryId) {
    const isFolder = folders.some((f) => f.id === selectedEntryId);
    if (isFolder) {
      return <FolderDashboard folderId={selectedEntryId} />;
    }
    return <EntryDashboard entryId={selectedEntryId} />;
  }

  // Priority 3: Entries exist but none selected -> show overview dashboard
  if (entries.length > 0 || folders.length > 0) {
    return <DashboardOverview />;
  }

  // Priority 4: No entries at all -> show centered welcome
  return (
    <div className="flex-1 flex items-center justify-center bg-canvas h-full">
      <div className="text-center max-w-md">
        <h2 className="text-2xl font-semibold text-ink-secondary mb-2">
          Welcome to Conduit
        </h2>
        <p className="text-ink-faint mb-6">
          Get started by creating your first entry or connecting to a remote host.
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => document.dispatchEvent(new CustomEvent("conduit:new-entry"))}
            className="px-4 py-2 bg-conduit-600 hover:bg-conduit-700 text-white rounded-md text-sm font-medium transition-colors"
          >
            New Entry
          </button>
          <button
            onClick={() => document.dispatchEvent(new CustomEvent("conduit:quick-connect"))}
            className="px-4 py-2 bg-raised hover:bg-stroke-dim rounded-md text-sm font-medium transition-colors"
          >
            Quick Connect
          </button>
        </div>
      </div>
    </div>
  );
}
