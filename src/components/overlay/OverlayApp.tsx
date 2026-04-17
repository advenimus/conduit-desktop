import { useState, useEffect, useCallback, useRef } from "react";
import OverlayToast from "./OverlayToast";
import OverlayUpdateNotification from "./OverlayUpdateNotification";
import type { OverlayState } from "../../types/toast";

export default function OverlayApp() {
  const [state, setState] = useState<OverlayState>({ toasts: [], update: null });
  const isOverToast = useRef(false);

  // Listen for state pushes from the main renderer
  useEffect(() => {
    const unlisten = window.electron.on("overlay:state-updated", (payload: unknown) => {
      setState(payload as OverlayState);
    });
    return () => { unlisten(); };
  }, []);

  // Theme sync: listen for localStorage changes from the main window
  useEffect(() => {
    const applyTheme = () => {
      const t = localStorage.getItem("conduit-theme") || "dark";
      const resolved = t === "system"
        ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : t;
      document.documentElement.classList.remove("dark", "light");
      document.documentElement.classList.add(resolved);

      const scheme = localStorage.getItem("conduit-color-scheme");
      if (scheme && scheme !== "ocean") {
        document.documentElement.setAttribute("data-scheme", scheme);
      } else {
        document.documentElement.removeAttribute("data-scheme");
      }

      const platform = localStorage.getItem("conduit-platform-theme");
      if (platform && platform !== "default") {
        document.documentElement.setAttribute("data-platform", platform);
      } else {
        document.documentElement.removeAttribute("data-platform");
      }
    };

    applyTheme();

    window.addEventListener("storage", applyTheme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", applyTheme);

    return () => {
      window.removeEventListener("storage", applyTheme);
      mq.removeEventListener("change", applyTheme);
    };
  }, []);

  // Click-through management: make the overlay interactive when mouse is over a toast
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const overToast = !!target.closest("[data-toast]");

      if (overToast && !isOverToast.current) {
        isOverToast.current = true;
        window.electron.send("overlay:set-mouse-ignore", { ignore: false });
      } else if (!overToast && isOverToast.current) {
        isOverToast.current = false;
        window.electron.send("overlay:set-mouse-ignore", { ignore: true, forward: true });
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  const handleDismiss = useCallback((toastId: string) => {
    window.electron.send("overlay:dismiss-toast", { toastId });
  }, []);

  const handleAction = useCallback((actionId: string) => {
    window.electron.send("overlay:action-clicked", { actionId });
  }, []);

  const handleUpdateAction = useCallback((action: 'download' | 'install' | 'dismiss' | 'retry' | 'website') => {
    window.electron.send("overlay:update-action", { action });
  }, []);

  const hasContent = state.toasts.length > 0 || state.update !== null;
  if (!hasContent) return null;

  return (
    <div className="flex flex-col justify-end items-stretch gap-2 w-full h-screen p-4">
      {state.update && (
        <OverlayUpdateNotification
          update={state.update}
          onAction={handleUpdateAction}
        />
      )}
      {state.toasts.map((t) => (
        <OverlayToast
          key={t.id}
          toast={t}
          onDismiss={handleDismiss}
          onAction={handleAction}
        />
      ))}
    </div>
  );
}
