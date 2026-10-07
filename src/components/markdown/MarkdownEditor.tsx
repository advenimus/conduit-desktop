import { useState, useRef, useCallback, useId } from "react";
import { IconButton, TabPanel, Tabs, type TabItem } from "../ui";
import MarkdownRenderer from "./MarkdownRenderer";
import { toolbarActions, type ToolbarAction } from "./markdownToolbar";
import AddSecretPopover from "./AddSecretPopover";
import { formatSecretRef } from "../../lib/kb";

type EditorTab = "write" | "preview";

const TABS: ReadonlyArray<TabItem<EditorTab>> = [
  { value: "write", label: "Write" },
  { value: "preview", label: "Preview" },
];

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minRows?: number;
  /** The saved entry this text belongs to; enables storing a secret right away. */
  ownerId?: string;
}

export default function MarkdownEditor({ value, onChange, placeholder = "Write markdown...", minRows = 8, ownerId }: MarkdownEditorProps) {
  const [tab, setTab] = useState<EditorTab>("write");
  const idBase = useId();
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

  const insertRef = useCallback(
    ({ id, label }: { id: string; label: string }) => {
      const ta = textareaRef.current;
      const at = ta?.selectionStart ?? value.length;
      const end = ta?.selectionEnd ?? at;
      const lineStart = value.lastIndexOf("\n", at - 1) + 1;
      // A label's "|" would split a Markdown table cell.
      const inTable = value.slice(lineStart).trimStart().startsWith("|");
      const ref = formatSecretRef(id, inTable ? null : label);
      onChange(value.slice(0, at) + ref + value.slice(end));
      requestAnimationFrame(() => {
        ta?.focus();
        ta?.setSelectionRange(at + ref.length, at + ref.length);
      });
    },
    [value, onChange]
  );

  return (
    <div className="overflow-hidden rounded border border-input-border bg-input">
      <Tabs idBase={idBase} items={TABS} value={tab} onChange={setTab} className="border-b border-divider" />

      <TabPanel idBase={idBase} value={tab}>
        {tab === "write" ? (
          <>
            <div className="flex flex-wrap items-center gap-0.5 border-b border-divider px-2 py-1">
              {toolbarActions.map((action, i) =>
                "separator" in action ? (
                  <div key={i} className="mx-1 h-4 w-px bg-divider" />
                ) : (
                  <IconButton key={i} size="sm" icon={action.icon} label={action.title} onClick={() => handleToolbar(action)} />
                )
              )}
              {ownerId && <AddSecretPopover ownerId={ownerId} onInsert={insertRef} />}
            </div>
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              rows={minRows}
              className="block w-full resize-y bg-transparent px-3 py-2 font-mono text-body text-(--c-input-fg) placeholder:text-(--c-input-placeholder)"
            />
          </>
        ) : (
          <div className="min-h-[8rem] overflow-y-auto px-3 py-2">
            {value.trim() ? (
              <MarkdownRenderer content={value} />
            ) : (
              <p className="text-body italic text-ink-faint">Nothing to preview</p>
            )}
          </div>
        )}
      </TabPanel>
    </div>
  );
}
