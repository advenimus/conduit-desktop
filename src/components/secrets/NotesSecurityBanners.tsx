import { useState } from "react";
import { invoke } from "../../lib/electron";
import { errorText } from "../../lib/errorText";
import { countPlaintextSecrets, readEmbedded } from "../../lib/kb";
import { useEntryStore } from "../../stores/entryStore";
import type { EntryMeta } from "../../types/entry";
import ConfirmDialog from "../common/ConfirmDialog";
import { toast } from "../common/Toast";
import { Banner } from "../ui";

/** Unencrypted !!secrets!! and unused encrypted secrets on one entry (docs/KNOWLEDGE_BASE.md 3). */
export default function NotesSecurityBanners({ entry }: { entry: EntryMeta }) {
  const loadAll = useEntryStore((s) => s.loadAll);
  const orphans = useEntryStore((s) =>
    s.hiddenEntries.filter((e) => {
      const embedded = readEmbedded(e.config);
      return embedded?.owner_id === entry.id && !!embedded.orphaned_at;
    }).length,
  );
  const [busy, setBusy] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);

  const content = (entry.config as { content?: unknown })?.content;
  const plaintext = countPlaintextSecrets(entry.notes) + countPlaintextSecrets(typeof content === "string" ? content : null);

  const run = async (command: string, done: (n: number) => string) => {
    setBusy(true);
    try {
      const n = await invoke<number>(command, command === "secret_encrypt_entry" ? { id: entry.id } : { owner_id: entry.id });
      await loadAll();
      toast.success(done(n));
    } catch (err) {
      toast.error(errorText(err, "Couldn't update the secrets"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {plaintext > 0 && (
        <Banner
          tone="warn"
          icon="lock"
          actions={[{ label: "Encrypt now", onClick: () => void run("secret_encrypt_entry", (n) => `${n} ${n === 1 ? "secret" : "secrets"} encrypted`), disabled: busy }]}
        >
          {plaintext === 1 ? "1 secret in these notes is" : `${plaintext} secrets in these notes are`} stored unencrypted.
        </Banner>
      )}
      {orphans > 0 && (
        <Banner tone="info" icon="key" actions={[{ label: "Clean up", onClick: () => setConfirmCleanup(true), disabled: busy }]}>
          {orphans === 1 ? "1 encrypted secret is" : `${orphans} encrypted secrets are`} no longer used in any notes.
        </Banner>
      )}
      {confirmCleanup && (
        <ConfirmDialog
          title="Delete unused secrets?"
          message={`${orphans === 1 ? "This secret is" : `These ${orphans} secrets are`} not linked from any notes or articles. Deleting cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          onCancel={() => setConfirmCleanup(false)}
          onConfirm={() => {
            setConfirmCleanup(false);
            void run("secret_cleanup_orphans", (n) => `${n} unused ${n === 1 ? "secret" : "secrets"} deleted`);
          }}
        />
      )}
    </>
  );
}
