import { useState } from "react";
import { invoke } from "../../../lib/electron";
import { errorText } from "../../../lib/errorText";
import { useEntryStore } from "../../../stores/entryStore";
import { toast } from "../../common/Toast";
import { Button, SectionHeader } from "../../ui";
import { HINT } from "../settings-styles";

/** Converts every !!secret!! left in notes and documents into an encrypted secret chip. */
export default function EncryptNotesSetting() {
  const [busy, setBusy] = useState(false);
  const loadAll = useEntryStore((s) => s.loadAll);

  const encryptAll = async () => {
    setBusy(true);
    try {
      const { entries, secrets } = await invoke<{ entries: number; secrets: number }>("secret_encrypt_all");
      await loadAll();
      toast.success(secrets === 0 ? "No unencrypted secrets found" : `${secrets} secrets encrypted in ${entries} ${entries === 1 ? "entry" : "entries"}`);
    } catch (err) {
      toast.error(errorText(err, "Couldn't encrypt the secrets"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SectionHeader title="Secrets in notes" />
      <p className={HINT}>
        Older notes may hold secrets written as !!secret!!, which are hidden on screen but stored unencrypted. This turns
        every one in this vault into an encrypted secret and keeps a link to it in the text.
      </p>
      <Button className="mt-2" onClick={() => void encryptAll()} loading={busy}>
        Encrypt secrets in all notes
      </Button>
    </div>
  );
}
