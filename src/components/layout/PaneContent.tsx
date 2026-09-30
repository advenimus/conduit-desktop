import { useSessionStore } from "../../stores/sessionStore";
import { useLayoutStore, findLeaf } from "../../stores/layoutStore";
import {
  TerminalView,
  RdpView,
  VncView,
  WebView,
  DocumentView,
  CommandView,
  ConnectionError,
} from "../sessions";
import EntryDashboard from "../dashboard/EntryDashboard";
import FolderDashboard from "../dashboard/FolderDashboard";
import DashboardOverview from "../dashboard/DashboardOverview";
import { Spinner } from "../ui";
import { dashboardViewOf } from "../../lib/dashboardSessions";

interface PaneContentProps {
  paneId: string;
  isFocused: boolean;
}

export default function PaneContent({ paneId, isFocused }: PaneContentProps) {
  const paneSessionIds = useLayoutStore((s) => {
    const pane = findLeaf(s.root, paneId);
    return pane?.sessionIds ?? [];
  });
  const paneActiveSessionId = useLayoutStore((s) => {
    const pane = findLeaf(s.root, paneId);
    return pane?.activeSessionId ?? null;
  });

  const sessions = useSessionStore((s) => s.sessions);

  const paneSessions = paneSessionIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter(Boolean) as typeof sessions;

  const renderSessionView = (session: (typeof sessions)[number]) => {
    const isPaneActive = session.id === paneActiveSessionId;
    const isActive = isPaneActive && isFocused;

    if (
      session.status === "connecting" &&
      session.type !== "rdp" &&
      session.type !== "document" &&
      session.type !== "command" &&
      session.type !== "dashboard"
    ) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center bg-editor text-ink-muted">
          <Spinner size={24} className="mb-4" />
          <p className="text-body">
            {session.metadata?.reconnecting
              ? `Reconnecting to ${session.title}...`
              : `Connecting to ${session.title}...`}
          </p>
        </div>
      );
    }

    if (
      session.status === "disconnected" &&
      session.type !== "rdp" &&
      session.type !== "document" &&
      session.type !== "command" &&
      session.type !== "dashboard"
    ) {
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
              useSessionStore.getState().updateSessionTitle(session.id, title);
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
            reconnecting={!!session.metadata?.reconnecting}
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
        return (
          <WebView sessionId={session.id} entryId={session.entryId} isActive={isActive} />
        );
      case "document":
        return <DocumentView entryId={session.entryId!} isActive={isActive} />;
      case "command":
        return (
          <CommandView sessionId={session.id} entryId={session.entryId!} isActive={isActive} />
        );
      case "dashboard": {
        const view = dashboardViewOf(session);
        if (view.kind === "folder") return <FolderDashboard folderId={view.folderId} />;
        if (view.kind === "entry") return <EntryDashboard entryId={view.entryId} />;
        return <DashboardOverview active={isPaneActive} />;
      }
      default:
        return (
          <p className="text-ink-faint">Unsupported session type: {session.type}</p>
        );
    }
  };

  // Sessions in this pane
  if (paneSessions.length > 0) {
    return (
      <>
        {paneSessions.map((session) => (
          <div
            key={session.id}
            className="h-full w-full"
            style={{
              display: session.id === paneActiveSessionId ? "flex" : "none",
            }}
          >
            {renderSessionView(session)}
          </div>
        ))}
      </>
    );
  }

  return <DashboardOverview />;
}
