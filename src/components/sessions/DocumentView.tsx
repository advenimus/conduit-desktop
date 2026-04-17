import { useState, useRef, useCallback, useEffect } from "react";
import { useEntryStore } from "../../stores/entryStore";
import MarkdownRenderer from "../markdown/MarkdownRenderer";
import { toolbarActions, type ToolbarAction } from "../markdown/markdownToolbar";
import ConfirmDialog from "../common/ConfirmDialog";
import { CloseIcon, FileTextIcon, FloppyIcon, PencilIcon } from "../../lib/icons";

interface DocumentViewProps {
  entryId: string;
  isActive: boolean;
}

export default function DocumentView({ entryId, isActive }: DocumentViewProps) {
  const entry = useEntryStore((s) => s.entries.find((e) => e.id === entryId));
  const updateEntry = useEntryStore((s) => s.updateEntry);

  const savedContent = (entry?.config as { content?: string })?.content ?? "";

  const [isEditing, setIsEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(savedContent);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isDirty = isEditing && draftContent !== savedContent;

  // Sync draft when saved content changes externally (e.g. after save)
  useEffect(() => {
    if (!isEditing) {
      setDraftContent(savedContent);
    }
  }, [savedContent, isEditing]);

  const handleEdit = () => {
    setDraftContent(savedContent);
    setIsEditing(true);
  };

  const handleSave = async () => {
    await updateEntry(entryId, {
      config: { content: draftContent },
    });
    setIsEditing(false);
  };

  const handleCancel = () => {
    if (isDirty) {
      setShowCloseConfirm(true);
      return;
    }
    setIsEditing(false);
  };

  const handleConfirmDiscard = () => {
    setShowCloseConfirm(false);
    setDraftContent(savedContent);
    setIsEditing(false);
  };

  const handleToolbar = useCallback(
    (action: ToolbarAction) => {
      if ("separator" in action) return;
      const ta = textareaRef.current;
      if (!ta) return;
      const result = action.action(ta, draftContent);
      setDraftContent(result.text);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(result.selStart, result.selEnd);
      });
    },
    [draftContent]
  );

  const wordCount = draftContent.trim()
    ? draftContent.trim().split(/\s+/).filter(Boolean).length
    : 0;

  if (!entry) {
    return (
      <div className="flex-1 flex items-center justify-center bg-canvas">
        <p className="text-ink-faint">Document not found</p>
      </div>
    );
  }

  if (!isActive) {
    return null;
  }

  // View mode
  if (!isEditing) {
    return (
      <div className="flex-1 flex flex-col bg-canvas h-full">
        {/* Header bar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-stroke bg-panel">
          <FileTextIcon size={18} className="text-teal-400" />
          <span className="text-sm font-medium text-ink truncate flex-1">{entry.name}</span>
          <span className="text-xs text-ink-faint">{wordCount} words</span>
          <button
            onClick={handleEdit}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-conduit-600 hover:bg-conduit-700 text-white rounded transition-colors"
          >
            <PencilIcon size={14} />
            Edit
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 allow-select">
          {savedContent.trim() ? (
            <div className="max-w-3xl mx-auto">
              <MarkdownRenderer content={savedContent} />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-ink-faint">
              <FileTextIcon size={48} stroke={1} className="mb-3 opacity-30" />
              <p className="text-sm">This document is empty</p>
              <button
                onClick={handleEdit}
                className="mt-3 text-sm text-conduit-400 hover:text-conduit-300 transition-colors"
              >
                Start writing
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Edit mode — split pane
  return (
    <>
      <div className="flex-1 flex flex-col bg-canvas h-full">
        {/* Header bar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-stroke bg-panel">
          <FileTextIcon size={18} className="text-teal-400" />
          <span className="text-sm font-medium text-ink truncate">{entry.name}</span>
          {isDirty && (
            <span className="text-xs text-amber-400 font-medium">Unsaved changes</span>
          )}
          <div className="flex-1" />
          <span className="text-xs text-ink-faint">{wordCount} words</span>
          <button
            onClick={handleCancel}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-raised rounded transition-colors"
          >
            <CloseIcon size={14} />
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-conduit-600 hover:bg-conduit-700 text-white rounded transition-colors"
          >
            <FloppyIcon size={14} />
            Save
          </button>
        </div>

        {/* Split pane */}
        <div className="flex-1 flex min-h-0">
          {/* Editor pane */}
          <div className="flex-1 flex flex-col border-r border-stroke min-w-0">
            {/* Toolbar */}
            <div className="flex items-center gap-0.5 px-2 py-1 border-b border-stroke bg-raised/30 flex-wrap">
              {toolbarActions.map((action, i) =>
                "separator" in action ? (
                  <div key={i} className="w-px h-4 bg-stroke mx-1" />
                ) : (
                  <button
                    key={i}
                    type="button"
                    title={action.title}
                    onClick={() => handleToolbar(action)}
                    className="p-1 rounded hover:bg-well text-ink-muted hover:text-ink transition-colors"
                  >
                    <action.icon size={14} />
                  </button>
                )
              )}
            </div>

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              placeholder="Write markdown..."
              autoFocus
              className="flex-1 w-full px-4 py-3 bg-transparent text-sm text-ink focus:outline-none resize-none font-mono"
            />
          </div>

          {/* Preview pane */}
          <div className="flex-1 overflow-y-auto p-4 min-w-0 allow-select">
            <div className="text-[10px] uppercase tracking-wider text-ink-faint font-semibold mb-2">Preview</div>
            {draftContent.trim() ? (
              <MarkdownRenderer content={draftContent} />
            ) : (
              <p className="text-sm text-ink-faint italic">Nothing to preview</p>
            )}
          </div>
        </div>
      </div>

      {showCloseConfirm && (
        <ConfirmDialog
          title="Unsaved Changes"
          message="You have unsaved changes. Are you sure you want to discard them?"
          confirmLabel="Discard"
          variant="danger"
          onConfirm={handleConfirmDiscard}
          onCancel={() => setShowCloseConfirm(false)}
        />
      )}
    </>
  );
}
