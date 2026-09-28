import { useEffect, useRef } from "react";
import { useSyncStore } from "../../stores/syncStore";

/**
 * Closing the unlock dialog forgets the sync error and the take-over request, so a later normal
 * unlock never takes the vault from another device. The reset waits one task: StrictMode runs
 * every effect's cleanup right after the first mount in development, and clearing there would
 * drop the take-over request the dialog was opened with ([Use here instead]).
 */
export function useForgetUnlockRequestOnClose(): void {
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (pending.current !== null) {
      clearTimeout(pending.current);
      pending.current = null;
    }
    return () => {
      pending.current = setTimeout(() => {
        pending.current = null;
        const sync = useSyncStore.getState();
        sync.setOpenError(null);
        sync.setTakeoverMode(false);
      }, 0);
    };
  }, []);
}
