import { useEffect } from "react";
import { useAiStore } from "../../stores/aiStore";
import ChatHistoryItem from "./ChatHistoryItem";
import { LoaderIcon, SearchIcon } from "../../lib/icons";

export default function ChatHistoryPanel() {
  const {
    persistentConversations,
    historyLoading,
    historySearchQuery,
    activeEngineConversationId,
    loadPersistentConversations,
    setHistorySearchQuery,
    loadEngineConversationHistory,
    deleteConversation,
    renameConversation,
  } = useAiStore();

  useEffect(() => {
    loadPersistentConversations();
  }, []);

  const handleSelectConversation = (id: string) => {
    loadEngineConversationHistory(id);
  };

  const currentActiveId = activeEngineConversationId;

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <SearchIcon
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
          />
          <input
            value={historySearchQuery}
            onChange={(e) => setHistorySearchQuery(e.target.value)}
            placeholder="Search conversations..."
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-well border border-stroke rounded focus:outline-none focus:ring-1 focus:ring-conduit-500 text-ink placeholder-ink-faint"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {historyLoading ? (
          <div className="flex items-center justify-center py-8">
            <LoaderIcon size={20} className="animate-spin text-ink-muted" />
          </div>
        ) : persistentConversations.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sm text-ink-muted">
              {historySearchQuery ? "No matching conversations" : "No chat history yet"}
            </p>
          </div>
        ) : (
          persistentConversations.map((conv) => (
            <ChatHistoryItem
              key={conv.id}
              conversation={conv}
              isActive={conv.id === currentActiveId}
              onClick={() => handleSelectConversation(conv.id)}
              onDelete={() => deleteConversation(conv.id)}
              onRename={(title) => renameConversation(conv.id, title)}
            />
          ))
        )}
      </div>
    </div>
  );
}
