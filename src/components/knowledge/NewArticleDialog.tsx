import { useState } from "react";
import { invoke } from "../../lib/electron";
import { errorText } from "../../lib/errorText";
import type { KbKind, KbScope } from "../../lib/kb";
import { useEntryStore } from "../../stores/entryStore";
import type { EntryMeta } from "../../types/entry";
import { toast } from "../common/Toast";
import { Button, Dialog, FormField, Select, TextInput } from "../ui";
import { KIND_META, NEW_ARTICLE_KINDS, openArticle, TEMPLATES } from "./kbUi";

interface NewArticleDialogProps {
  scope: KbScope;
  entryId?: string;
  folderId?: string;
  initialKind?: KbKind;
  /** The dashboard tab to open the new article in; its owner's tab when left out. */
  host?: string;
  onClose: () => void;
}

export default function NewArticleDialog({ scope, entryId, folderId, initialKind = "procedure", host, onClose }: NewArticleDialogProps) {
  const [kind, setKind] = useState<KbKind>(initialKind);
  const [title, setTitle] = useState(initialKind === "overview" ? "Overview" : "");
  const [busy, setBusy] = useState(false);
  const loadAll = useEntryStore((s) => s.loadAll);

  const create = async () => {
    setBusy(true);
    try {
      const created = await invoke<EntryMeta>("kb_create", {
        scope,
        entry_id: entryId ?? null,
        folder_id: folderId ?? null,
        kind,
        title: title.trim(),
        content: TEMPLATES[kind],
      });
      await loadAll();
      openArticle(created.id, host);
      onClose();
    } catch (err) {
      toast.error(errorText(err, "Couldn't create the article"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="New knowledge article"
      icon="notes"
      width={440}
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) void create();
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim()} loading={busy}>
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value as KbKind)}>
            {NEW_ARTICLE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_META[k].label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Title">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Restart the web stack" autoFocus maxLength={200} />
        </FormField>
        <p className="text-label text-ink-faint">
          {scope === "folder"
            ? "Every asset in this folder and its sub-folders will see this article."
            : scope === "vault"
              ? "A vault playbook reaches assets that share one of its tags, or every asset when pinned."
              : "This article belongs to this asset."}
        </p>
      </div>
    </Dialog>
  );
}
