import { useState, useEffect, useCallback, useRef } from "react";
import { invoke, listen } from "../../lib/electron";
import { toast } from "./Toast";
import type { UpdateState } from "../../types/toast";

interface UpdateInfo {
  version: string;
  body: string | null;
  date: string | null;
  downloaded: boolean;
}

/** Push the current update state to the overlay via IPC */
let pushUpdateState: ((state: UpdateState | null) => void) | null = null;

export function setPushUpdateState(fn: (state: UpdateState | null) => void): void {
  pushUpdateState = fn;
}

/**
 * Update notification bridge — manages update lifecycle state and pushes
 * serialized state to the overlay window. Renders nothing to DOM.
 *
 * With autoDownload enabled, updates download silently in the background.
 * Shows progress during download, then "Restart Now" when ready.
 */
export default function UpdateNotificationBridge() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [state, setState] = useState<"downloading" | "downloaded" | "error">("downloading");
  const [progress, setProgress] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const dismissedVersionRef = useRef<string | null>(null);

  // Push state to overlay whenever it changes
  useEffect(() => {
    if (!update || dismissed) {
      pushUpdateState?.(null);
      return;
    }
    pushUpdateState?.({
      state,
      version: update.version,
      progress,
      body: update.body,
    });
  }, [update, state, progress, dismissed]);

  useEffect(() => {
    // Check for cached update on mount (no API call)
    invoke<UpdateInfo | null>("check_for_updates")
      .then((result) => {
        if (result?.downloaded) {
          setUpdate(result);
          setState("downloaded");
        } else if (result) {
          setUpdate(result);
          setState("downloading");
          setProgress(0);
        }
      })
      .catch(() => {});

    // Listen for update-available (download starting automatically)
    const unlistenAvailable = listen<{ version: string; body: string | null; date: string | null }>(
      "update:available",
      (event) => {
        const { version, body, date } = event.payload;
        if (dismissedVersionRef.current === version) return;
        setUpdate({ version, body, date, downloaded: false });
        setState("downloading");
        setProgress(0);
        setDismissed(false);
      }
    );

    // Listen for download progress
    const unlistenProgress = listen<{ percent: number }>(
      "update:progress",
      (event) => {
        setProgress(event.payload.percent);
      }
    );

    // Listen for completed download — show restart button
    const unlistenDownloaded = listen<{ version: string }>(
      "update:downloaded",
      (event) => {
        const version = event.payload.version;
        if (dismissedVersionRef.current === version) return;
        setUpdate((prev) => prev
          ? { ...prev, downloaded: true, version }
          : { version, body: null, date: null, downloaded: true });
        setState("downloaded");
        setProgress(100);
        setDismissed(false);
      }
    );

    const unlistenError = listen<{ message: string }>(
      "update:error",
      () => {
        setState("error");
      }
    );

    // Listen for manual "Check for Updates" from Help menu
    const handleCheckForUpdates = async () => {
      setDismissed(false);
      dismissedVersionRef.current = null;
      try {
        const result = await invoke<UpdateInfo | null>("force_check_for_updates");
        if (result?.downloaded) {
          setUpdate(result);
          setState("downloaded");
        } else if (result) {
          // update:available event will handle the UI
          toast.info(`Checking for update v${result.version}...`);
        } else {
          setUpdate(null);
          toast.info("Conduit is up to date.");
        }
      } catch {
        // Check failed — silently ignore
      }
    };

    document.addEventListener("conduit:check-for-updates", handleCheckForUpdates);

    return () => {
      unlistenAvailable.then((fn) => fn());
      unlistenProgress.then((fn) => fn());
      unlistenDownloaded.then((fn) => fn());
      unlistenError.then((fn) => fn());
      document.removeEventListener("conduit:check-for-updates", handleCheckForUpdates);
    };
  }, []);

  const handleInstall = useCallback(async () => {
    try {
      await invoke("install_update");
    } catch {
      setState("error");
    }
  }, []);

  const handleDismiss = useCallback(() => {
    if (update?.version) {
      dismissedVersionRef.current = update.version;
    }
    setDismissed(true);
  }, [update]);

  // Listen for update actions from the overlay window
  useEffect(() => {
    const unlisten = window.electron.on("overlay:update-action", (data: unknown) => {
      const { action } = data as { action: string };
      switch (action) {
        case "install":
          handleInstall();
          break;
        case "dismiss":
          handleDismiss();
          break;
        case "website":
          invoke("auth_open_download");
          break;
      }
    });
    return () => { unlisten(); };
  }, [handleInstall, handleDismiss]);

  // State-only bridge — renders nothing
  return null;
}
