import { useEffect, useRef, useState } from "react";
import { useEntryStore } from "../../../stores/entryStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { OPEN_ALL_CONFIRM_THRESHOLD } from "../../../types/dashboard";
import ConfirmDialog from "../../common/ConfirmDialog";
import { Button } from "../../ui";

const NOTHING_TO_OPEN = "Nothing to open here";

/**
 * Opens the listed connection entries one after another; asks first above five (docs/DASHBOARD.md 5).
 * Stops before the next entry once the view unmounts or the vault locks.
 */
export default function OpenAllButton({ entryIds }: { entryIds: readonly string[] }) {
  const [confirming, setConfirming] = useState<readonly string[] | null>(null);
  const [opening, setOpening] = useState(false);
  const mounted = useRef(true);
  const count = entryIds.length;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const openAll = async (ids: readonly string[]) => {
    setConfirming(null);
    setOpening(true);
    try {
      const { openEntry } = useEntryStore.getState();
      for (const id of ids) {
        if (!mounted.current || !useVaultStore.getState().isUnlocked) break;
        await openEntry(id);
      }
    } finally {
      if (mounted.current) setOpening(false);
    }
  };

  const onClick = () => {
    if (count > OPEN_ALL_CONFIRM_THRESHOLD) setConfirming([...entryIds]);
    else void openAll(entryIds);
  };

  return (
    <>
      {/* A disabled Button takes no pointer events, so the wrapper carries the reason's tooltip. */}
      <span className="inline-flex" title={count === 0 ? NOTHING_TO_OPEN : undefined}>
        <Button
          variant="primary"
          disabled={count === 0 || opening}
          title={count === 0 ? NOTHING_TO_OPEN : undefined}
          onClick={onClick}
        >
          Open all
        </Button>
      </span>
      {confirming && (
        <ConfirmDialog
          title={`Open ${confirming.length} connections?`}
          message={`This opens ${confirming.length} sessions at once. Commands and documents are not opened.`}
          confirmLabel={`Open ${confirming.length}`}
          cancelLabel="Cancel"
          onConfirm={() => void openAll(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}
