import { useState, useRef, useCallback, useEffect } from "react";
import { useEntryStore } from "../../stores/entryStore";
import MarkdownRenderer from "../markdown/MarkdownRenderer";
import { toolbarActions, type ToolbarAction } from "../markdown/markdownToolbar";
import ConfirmDialog from "../common/ConfirmDialog";
import { CloseIcon, FileTextIcon, FloppyIcon, PencilIcon } from "../../lib/icons";
import { Button, IconButton } from "../ui";
import AddSecretPopover from "../markdown/AddSecretPopover";
import ArticleHeader from "../knowledge/ArticleHeader";
import { articleOf } from "../knowledge/kbUi";
import { kbCall } from "../knowledge/kbActions";

interface DocumentViewProps {
  entryId: string;
  isActive: boolean;
}

export default function DocumentView({ entryId, isActive }: DocumentViewProps) {
  const entry = useEntryStore((s) => s.entries.find((e) => e.id === entryId) ?? s.hiddenEntries.find((e) => e.id === entryId));
  const updateEntry = useEntryStore((s) => s.updateEntry);
  const article = articleOf(entry);

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
    if (article) {
      // Article saves go through the knowledge store so they get a revision and encrypt secrets.
      if ((await kbCall("kb_update", { id: entryId, content: draftContent }, "Couldn't save the article")) === null) return;
    } else {
      await updateEntry(entryId, {
        config: { ...(entry?.config ?? {}), content: draftContent },
      });
    }
    setIsEditing(false);
  };

  const insertSecretRef = useCallback(
    ({ id, label }: { id: string; label: string }) => {
      const ta = textareaRef.current;
      const at = ta?.selectionStart ?? draftContent.length;
      const lineStart = draftContent.lastIndexOf("\n", at - 1) + 1;
      const inTable = draftContent.slice(lineStart).trimStart().startsWith("|");
      const ref = inTable ? `{{secret:${id}}}` : `{{secret:${id}|${label.replace(/[{}|\r\n]/g, " ")}}}`;
      setDraftContent(draftContent.slice(0, at) + ref + draftContent.slice(ta?.selectionEnd ?? at));
    },
    [draftContent]
  );

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
      <div className="flex-1 flex items-center justify-center bg-editor">
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
      <div className="flex-1 flex flex-col bg-editor h-full">
        {/* Header bar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-divider bg-editor">
          <FileTextIcon size={16} className="text-entry-document" />
          <span className="text-body font-semibold text-ink truncate flex-1">{entry.name}</span>
          <span className="text-meta text-ink-faint">{wordCount} words</span>
          <Button size="sm" variant="primary" icon={PencilIcon} onClick={handleEdit}>
            Edit
          </Button>
        </div>

        {article && <ArticleHeader entry={entry} kb={article.kb} />}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 allow-select">
          {savedContent.trim() ? (
            <div className="max-w-3xl mx-auto">
              <MarkdownRenderer content={savedContent} />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-ink-faint">
              <FileTextIcon size={48} stroke={1} className="mb-3 opacity-30" />
              <p className="text-body">This document is empty</p>
              <Button variant="link" className="mt-3" onClick={handleEdit}>
                Start writing
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Edit mode — split pane
  return (
    <>
      <div className="flex-1 flex flex-col bg-editor h-full">
        {/* Header bar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-divider bg-editor">
          <FileTextIcon size={16} className="text-entry-document" />
          <span className="text-body font-semibold text-ink truncate">{entry.name}</span>
          {isDirty && (
            <span className="text-meta text-warning font-semibold">Unsaved changes</span>
          )}
          <div className="flex-1" />
          <span className="text-meta text-ink-faint">{wordCount} words</span>
          <Button size="sm" variant="ghost" icon={CloseIcon} onClick={handleCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" icon={FloppyIcon} onClick={handleSave}>
            Save
          </Button>
        </div>

        {/* Split pane */}
        <div className="flex-1 flex min-h-0">
          {/* Editor pane */}
          <div className="flex-1 flex flex-col border-r border-divider min-w-0">
            {/* Toolbar */}
            <div className="flex items-center gap-1 px-2 py-1 border-b border-divider bg-editor flex-wrap">
              {toolbarActions.map((action, i) =>
                "separator" in action ? (
                  <div key={i} className="w-px h-4 bg-divider mx-1.5" />
                ) : (
                  <IconButton
                    key={i}
                    size="sm"
                    icon={action.icon}
                    label={action.title}
                    onClick={() => handleToolbar(action)}
                  />
                )
              )}
              <AddSecretPopover ownerId={entry.id} onInsert={insertSecretRef} />
            </div>

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              placeholder="Write markdown..."
              autoFocus
              className="flex-1 w-full px-4 py-3 bg-transparent text-body text-ink resize-none font-mono"
            />
          </div>

          {/* Preview pane */}
          <div className="flex-1 overflow-y-auto p-4 min-w-0 allow-select">
            <div className="text-meta font-semibold text-ink-muted mb-2">Preview</div>
            {draftContent.trim() ? (
              <MarkdownRenderer content={draftContent} />
            ) : (
              <p className="text-body text-ink-faint italic">Nothing to preview</p>
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
