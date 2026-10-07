import { useState } from "react";
import { readHistory, type KbRevision } from "../../lib/kb";
import type { EntryMeta } from "../../types/entry";
import { formatRelativeTime } from "../dashboard/relativeTime";
import { toast } from "../common/Toast";
import { Button, Dialog } from "../ui";
import DiffView from "./DiffView";
import { contentOf } from "./kbUi";
import { kbCall } from "./kbActions";

const who = (r: KbRevision) => (r.author.kind === "agent" ? (r.author.name ?? "An AI agent") : r.author.device === "ios" ? "You (iPhone)" : "You");

/** Every kept revision of an article; pick one to compare with the current text and restore it. */
export default function ArticleHistoryDialog({ entry, onClose }: { entry: EntryMeta; onClose: () => void }) {
  const history = readHistory(entry.config as Record<string, unknown>).slice().reverse();
  const current = contentOf(entry);
  const [selected, setSelected] = useState<KbRevision | null>(history[1] ?? history[0] ?? null);
  const [busy, setBusy] = useState(false);

  const restore = async () => {
    if (!selected) return;
    setBusy(true);
    const ok = await kbCall("kb_restore", { id: entry.id, at: selected.at }, "Couldn't restore that version");
    setBusy(false);
    if (ok) {
      toast.success("Version restored");
      onClose();
    }
  };

  return (
    <Dialog
      open
      title={`History of ${entry.name}`}
      icon="history"
      size="xl"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => void restore()} disabled={!selected || selected.content === current} loading={busy}>
            Restore this version
          </Button>
        </>
      }
    >
      <div className="flex min-h-[320px] gap-3">
        <ul className="w-56 shrink-0 space-y-0.5 overflow-y-auto">
          {history.map((r, i) => (
            <li key={r.at}>
              <button
                type="button"
                onClick={() => setSelected(r)}
                className={`w-full rounded px-2 py-1.5 text-left ${selected?.at === r.at ? "bg-selected" : "hover:bg-hover"}`}
              >
                <span className="block text-body text-ink">{who(r)}{i === 0 ? " · current" : ""}</span>
                <span className="block text-meta text-ink-faint">{formatRelativeTime(r.at)}</span>
                {r.reason && <span className="block truncate text-label text-ink-muted">{r.reason}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1">
          {selected ? (
            <>
              <p className="mb-2 text-label text-ink-faint">Changes from this version to the current text</p>
              <DiffView before={selected.content} after={current} />
            </>
          ) : (
            <p className="text-body text-ink-muted">No history yet.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
