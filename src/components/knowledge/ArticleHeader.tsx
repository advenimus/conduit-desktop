import { useRef, useState } from "react";
import { hasUnseenAgentEdit, isStale, type KbKind, type KbMeta } from "../../lib/kb";
import { useEntryStore } from "../../stores/entryStore";
import type { EntryMeta } from "../../types/entry";
import ConfirmDialog from "../common/ConfirmDialog";
import { toast } from "../common/Toast";
import { formatRelativeTime } from "../dashboard/relativeTime";
import { Banner, Button, IconButton, Menu, MenuItem, Popover, Select } from "../ui";
import ArticleHistoryDialog from "./ArticleHistoryDialog";
import ReviewChangesDialog from "./ReviewChangesDialog";
import { editorLabel, KIND_META } from "./kbUi";
import { kbCall } from "./kbActions";
import { useSessionStore } from "../../stores/sessionStore";

/** The strip above a knowledge article: where it belongs, its kind, verification, history and review. */
export default function ArticleHeader({ entry, kb }: { entry: EntryMeta; kb: KbMeta }) {
  const owner = useEntryStore((s) => (entry.parent_entry_id ? s.entries.find((e) => e.id === entry.parent_entry_id) : undefined));
  const folder = useEntryStore((s) => (entry.folder_id ? s.folders.find((f) => f.id === entry.folder_id) : undefined));
  const [dialog, setDialog] = useState<"history" | "review" | "delete" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);

  const where = kb.scope === "asset" ? (owner?.name ?? "Asset") : kb.scope === "folder" ? (folder?.name ?? "Folder") : "Vault";
  const unseen = hasUnseenAgentEdit(kb);
  const stale = isStale(kb, entry.updated_at, new Date().toISOString());
  const update = (changes: Record<string, unknown>, failure: string) => kbCall("kb_update", { id: entry.id, ...changes }, failure);

  const remove = async () => {
    setDialog(null);
    if ((await kbCall("kb_delete", { id: entry.id }, "Couldn't delete the article")) !== null) {
      useSessionStore.getState().removeSession(entry.id);
      toast.success("Article deleted");
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-divider px-4 py-1.5 text-label" data-cv-kb-header={entry.id}>
        <span className="text-ink-faint">
          {where} › Knowledge ·
        </span>
        <span className="w-40 shrink-0">
          <Select value={kb.kind} onChange={(e) => void update({ kind: e.target.value as KbKind }, "Couldn't change the kind")} aria-label="Kind">
            {(Object.keys(KIND_META) as KbKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_META[k].label}
              </option>
            ))}
          </Select>
        </span>
        <span className="text-ink-faint">
          {editorLabel(kb)} · {formatRelativeTime(entry.updated_at)}
        </span>
        <div className="flex-1" />
        {kb.verified_at && !stale ? (
          <span className="text-success" title={kb.verify_note ?? undefined}>Verified {formatRelativeTime(kb.verified_at)}</span>
        ) : (
          <Button size="sm" icon="circleCheck" onClick={() => void kbCall("kb_verify", { id: entry.id, still_true: true }, "Couldn't mark it verified")}>
            Mark verified
          </Button>
        )}
        <IconButton
          size="sm"
          icon={kb.pinned ? "pinFilled" : "pin"}
          label={kb.pinned ? "Unpin" : "Pin to the top"}
          onClick={() => void update({ pinned: !kb.pinned }, "Couldn't pin the article")}
        />
        <IconButton size="sm" icon="history" label="History" onClick={() => setDialog("history")} />
        <span ref={menuRef}>
          <IconButton size="sm" icon="ellipsis" label="More" onClick={() => setMenuOpen((o) => !o)} />
        </span>
        <Popover anchorRef={menuRef} open={menuOpen} onClose={() => setMenuOpen(false)} placement="bottom-end" padding={false}>
          <Menu onClose={() => setMenuOpen(false)}>
            {kb.status === "archived" ? (
              <MenuItem icon="restore" onSelect={() => void update({ status: "active" }, "Couldn't restore the article")}>Unarchive</MenuItem>
            ) : (
              <MenuItem icon="folder" onSelect={() => void update({ status: "archived" }, "Couldn't archive the article")}>Archive</MenuItem>
            )}
            {kb.status !== "needs_review" && (
              <MenuItem icon="alertTriangle" onSelect={() => void kbCall("kb_verify", { id: entry.id, still_true: false }, "Couldn't flag the article")}>Flag as needs review</MenuItem>
            )}
            <MenuItem icon="trash" danger onSelect={() => setDialog("delete")}>Delete</MenuItem>
          </Menu>
        </Popover>
      </div>

      {unseen && (
        <Banner tone="info" icon="robot" actions={[{ label: "Review", onClick: () => setDialog("review"), primary: true }]}>
          {editorLabel(kb)} edited this {formatRelativeTime(kb.last_editor!.at)}. Review what changed?
        </Banner>
      )}
      {kb.status === "needs_review" && !unseen && (
        <Banner tone="warn" actions={[{ label: "It's correct", onClick: () => void kbCall("kb_verify", { id: entry.id, still_true: true }, "Couldn't mark it verified") }]}>
          Someone flagged this article as possibly out of date{kb.verify_note ? `: ${kb.verify_note}` : "."}
        </Banner>
      )}
      {kb.status === "archived" && (
        <Banner tone="lock" icon="folder" actions={[{ label: "Unarchive", onClick: () => void update({ status: "active" }, "Couldn't restore the article") }]}>
          This article is archived. Agents and lists leave it out.
        </Banner>
      )}

      {dialog === "history" && <ArticleHistoryDialog entry={entry} onClose={() => setDialog(null)} />}
      {dialog === "review" && <ReviewChangesDialog entry={entry} kb={kb} onClose={() => setDialog(null)} />}
      {dialog === "delete" && (
        <ConfirmDialog
          title="Delete this article?"
          message="The article, its history and the secrets it holds are deleted. This cannot be undone. Archive it instead to keep it out of the way."
          confirmLabel="Delete"
          variant="danger"
          onCancel={() => setDialog(null)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}
