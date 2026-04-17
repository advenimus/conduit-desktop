import { useState, useRef, useEffect } from "react";
import type { PersistentConversationInfo } from "../../stores/aiStore";
import {
  CheckIcon, CloseIcon, PencilIcon, PinFilledIcon, TrashIcon
} from "../../lib/icons";

interface ChatHistoryItemProps {
  conversation: PersistentConversationInfo;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ChatHistoryItem({
  conversation,
  isActive,
  onClick,
  onDelete,
  onRename,
}: ChatHistoryItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditTitle(conversation.title ?? "");
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    if (editTitle.trim()) {
      onRename(editTitle.trim());
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const providerBadge = (() => {
    switch (conversation.provider) {
      case 'anthropic': return 'Claude';
      case 'openai': return 'GPT';
      case 'claude-code': return 'Claude Code';
      case 'codex': return 'Codex';
      default: return conversation.provider;
    }
  })();
  const title = conversation.title || "New conversation";

  return (
    <div
      className={`group flex items-start gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
        isActive
          ? "bg-conduit-600/20 border border-conduit-600/30"
          : "hover:bg-raised border border-transparent"
      }`}
      onClick={onClick}
    >
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <input
              ref={inputRef}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveEdit();
                if (e.key === "Escape") handleCancelEdit();
              }}
              className="flex-1 px-1.5 py-0.5 text-sm bg-well border border-stroke rounded focus:outline-none focus:ring-1 focus:ring-conduit-500"
            />
            <button onClick={handleSaveEdit} className="p-0.5 text-green-400 hover:text-green-300">
              <CheckIcon size={14} />
            </button>
            <button onClick={handleCancelEdit} className="p-0.5 text-ink-muted hover:text-ink">
              <CloseIcon size={14} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {conversation.isPinned && (
              <PinFilledIcon size={12} className="text-conduit-400 flex-shrink-0" />
            )}
            <p className="text-sm text-ink truncate">{title}</p>
          </div>
        )}

        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-well text-ink-muted">
            {providerBadge}
          </span>
          <span className="text-[10px] text-ink-faint">
            {conversation.messageCount} msgs
          </span>
          <span className="text-[10px] text-ink-faint">
            {timeAgo(conversation.updatedAt)}
          </span>
        </div>
      </div>

      {/* Actions */}
      {!isEditing && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          <button
            onClick={handleStartEdit}
            className="p-1 hover:bg-well rounded text-ink-muted hover:text-ink"
            title="Rename"
          >
            <PencilIcon size={13} />
          </button>

          {showDeleteConfirm ? (
            <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => { onDelete(); setShowDeleteConfirm(false); }}
                className="p-1 text-red-400 hover:text-red-300 text-[10px] font-medium"
              >
                Delete
              </button>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="p-1 text-ink-muted hover:text-ink text-[10px]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); }}
              className="p-1 hover:bg-well rounded text-ink-muted hover:text-red-400"
              title="Delete"
            >
              <TrashIcon size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
