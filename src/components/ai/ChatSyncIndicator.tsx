import { useEffect } from "react";
import { useAiStore, initChatSyncListener } from "../../stores/aiStore";
import { AlertTriangleIcon, CloudIcon, LoaderIcon } from "../../lib/icons";

export default function ChatSyncIndicator() {
  const { chatSyncState, fetchChatSyncState } = useAiStore();

  useEffect(() => {
    initChatSyncListener();
    fetchChatSyncState();
  }, []);

  if (!chatSyncState || !chatSyncState.enabled) return null;

  const { status } = chatSyncState;

  let icon;
  let title: string;

  switch (status) {
    case "syncing":
      icon = <LoaderIcon size={14} className="animate-spin text-conduit-400" />;
      title = "Syncing chat history...";
      break;
    case "synced":
      icon = <CloudIcon size={14} className="text-green-400" />;
      title = chatSyncState.lastSyncedAt
        ? `Chat synced: ${new Date(chatSyncState.lastSyncedAt).toLocaleTimeString()}`
        : "Chat sync enabled";
      break;
    case "error":
      icon = <AlertTriangleIcon size={14} className="text-amber-400" />;
      title = `Sync error: ${chatSyncState.error}`;
      break;
    default:
      icon = <CloudIcon size={14} className="text-ink-muted" />;
      title = "Chat sync enabled";
  }

  return (
    <div className="p-1" title={title}>
      {icon}
    </div>
  );
}
