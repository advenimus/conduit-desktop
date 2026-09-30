import { errorText } from "../../lib/errorText";
import { useSyncStore } from "../../stores/syncStore";
import { useEntryStore } from "../../stores/entryStore";
import { toast } from "../common/Toast";
import { IconSlot } from "../ui";
import { noticeText } from "./sync-copy";
import SmallButton from "./SmallButton";
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
        <div key={n.id} data-cv-sync-notice="" className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-bg p-2.5">
          <IconSlot icon="alertTriangle" className="mt-px shrink-0 text-warning" />
          <p data-cv-sync-notice-text="" className="flex-1 text-label text-ink-secondary">{noticeText(n, itemName(n))}</p>
          {n.kind === "mass-change" && (
            <SmallButton primary onClick={() => useSyncStore.getState().openView({ kind: "mass-change", noticeId: n.id })}>
              Review
            </SmallButton>
          )}
          <SmallButton onClick={() => dismiss(n.id)}>OK</SmallButton>
        </div>
      ))}
    </div>
  );
}
