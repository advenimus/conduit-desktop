import { errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { useEntryStore } from "../../stores/entryStore";
import { toast } from "../common/Toast";
import { AlertTriangleIcon } from "../../lib/icons";
import { noticeText } from "./sync-copy";
import { smallButton } from "./ConflictFieldRow";
import type { LocalNotice } from "../../types/sync";

const NO_NOTICES: readonly LocalNotice[] = [];
const ENTRY_TBL = 1;
const FOLDER_TBL = 2;

/** Persisted sync notices of the open vault with [Review] (mass change) and [OK]. */
export default function SyncNoticeList() {
  const notices = useSyncStore((s) => s.state?.notices ?? NO_NOTICES);
  const entries = useEntryStore((s) => s.entries);
  const folders = useEntryStore((s) => s.folders);
  if (notices.length === 0) return null;
  const itemName = (n: LocalNotice): string | null => {
    if (n.key?.tbl === ENTRY_TBL) return entries.find((e) => e.id === n.key?.rowId)?.name ?? null;
    if (n.key?.tbl === FOLDER_TBL) return folders.find((f) => f.id === n.key?.rowId)?.name ?? null;
    return null;
  };
  const dismiss = (id: string) =>
    void useSyncStore.getState().dismissNotice(id).catch((err) => toast.error("Could not dismiss", errorText(err, "Try again.")));
  return (
    <div className="space-y-2">
      {notices.map((n) => (
        <div key={n.id} className="flex items-start gap-2 p-2.5 rounded-md bg-amber-500/10 border border-amber-500/20">
          <AlertTriangleIcon size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
          <p className="flex-1 text-xs text-ink-secondary">{noticeText(n, itemName(n))}</p>
          {n.kind === "mass-change" && (
            <button type="button" onClick={() => useSyncStore.getState().openView({ kind: "mass-change", noticeId: n.id })} className={smallButton(true)}>
              Review
            </button>
          )}
          <button type="button" onClick={() => dismiss(n.id)} className={smallButton()}>OK</button>
        </div>
      ))}
    </div>
  );
}
