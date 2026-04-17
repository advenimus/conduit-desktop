import { useState, useRef, useCallback } from "react";
import MarkdownRenderer from "./MarkdownRenderer";
import { toolbarActions, type ToolbarAction } from "./markdownToolbar";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minRows?: number;
}

export default function MarkdownEditor({ value, onChange, placeholder = "Write markdown...", minRows = 8 }: MarkdownEditorProps) {
  const [tab, setTab] = useState<"write" | "preview">("write");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleToolbar = useCallback(
    (action: ToolbarAction) => {
      if ("separator" in action) return;
      const ta = textareaRef.current;
      if (!ta) return;
      const result = action.action(ta, value);
      onChange(result.text);
      // Restore focus and selection after React re-render
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(result.selStart, result.selEnd);
      });
    },
    [value, onChange]
  );

  return (
    <div className="border border-stroke rounded overflow-hidden bg-well">
      {/* Tab bar */}
      <div className="flex items-center border-b border-stroke bg-raised/50">
        <button
          type="button"
          onClick={() => setTab("write")}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === "write"
              ? "text-ink border-b-2 border-conduit-500"
              : "text-ink-muted hover:text-ink"
          }`}
        >
          Write
        </button>
        <button
          type="button"
          onClick={() => setTab("preview")}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === "preview"
              ? "text-ink border-b-2 border-conduit-500"
              : "text-ink-muted hover:text-ink"
          }`}
        >
          Preview
        </button>
      </div>

      {/* Toolbar (write mode only) */}
      {tab === "write" && (
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
                <action.icon size={14} stroke={1.5} />
              </button>
            )
          )}
        </div>
      )}

      {/* Content area */}
      {tab === "write" ? (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={minRows}
          className="w-full px-3 py-2 bg-transparent text-sm text-ink focus:outline-none resize-y font-mono"
        />
      ) : (
        <div className="px-3 py-2 min-h-[8rem] overflow-y-auto">
          {value.trim() ? (
            <MarkdownRenderer content={value} />
          ) : (
            <p className="text-sm text-ink-faint italic">Nothing to preview</p>
          )}
        </div>
      )}
    </div>
  );
}
