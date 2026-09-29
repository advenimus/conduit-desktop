import { useEffect } from "react";
import type { OverlayState, SerializedToast } from "../../types/toast";
import { ToastController, setPushOverlayState } from "./Toast";

/**
 * Toasts for a window with no update notification, such as the credential picker. The main process
 * gives that window an overlay of its own; this sends the window's toast list to it.
 */
export default function WindowToasts() {
  useEffect(() => {
    setPushOverlayState((toasts: SerializedToast[]) => {
      const state: OverlayState = { toasts, update: null };
      window.electron.send("overlay:push-state", state);
    });
    return () => setPushOverlayState(() => {});
  }, []);

  return <ToastController />;
}
