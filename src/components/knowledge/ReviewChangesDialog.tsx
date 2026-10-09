import { useState } from "react";
import { baselineRevision, readHistory, type KbMeta } from "../../lib/kb";
import type { EntryMeta } from "../../types/entry";
import { toast } from "../common/Toast";
import { Button, Dialog } from "../ui";
import DiffView from "./DiffView";
import { contentOf, editorLabel } from "./kbUi";
import { kbCall } from "./kbActions";

/** Shows what an agent changed since the user last looked, then keeps or undoes it (docs/KNOWLEDGE_BASE.md 5). */
export default function ReviewChangesDialog({ entry, kb, onClose }: { entry: EntryMeta; kb: KbMeta; onClose: () => void }) {
  const baseline = baselineRevision(readHistory(entry.config as Record<string, unknown>), kb.reviewed_at);
  const [busy, setBusy] = useState(false);

  const act = async (command: "kb_keep" | "kb_undo" | "archive") => {
    setBusy(true);
    const ok = command === "archive"
      ? await kbCall("kb_update", { id: entry.id, status: "archived" }, "Couldn't archive the article")
      : await kbCall(command, { id: entry.id }, "Couldn't update the article");
    setBusy(false);
    if (ok !== null) {
      toast.success(command === "kb_keep" ? "Changes kept" : command === "kb_undo" ? "Agent changes undone" : "Article archived");
      onClose();
    }
  };

  return (
    <Dialog
      open
      title={`Review changes by ${editorLabel(kb)}`}
      icon="robot"
      size="lg"
      onClose={onClose}
      footer={
        <>
          {baseline ? (
            <Button onClick={() => void act("kb_undo")} disabled={busy}>
              Undo changes
            </Button>
          ) : (
            <Button variant="danger" onClick={() => void act("archive")} disabled={busy}>
              Archive article
            </Button>
          )}
          <Button variant="primary" onClick={() => void act("kb_keep")} loading={busy}>
            Keep
          </Button>
        </>
      }
    >
      {baseline ? (
        <DiffView before={baseline.content} after={contentOf(entry)} />
      ) : (
        <>
          <p className="mb-2 text-body text-ink-muted">An agent created this article and nobody has reviewed it yet.</p>
          <DiffView before="" after={contentOf(entry)} />
        </>
      )}
    </Dialog>
  );
}
