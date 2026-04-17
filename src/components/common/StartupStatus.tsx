import { useState, useEffect, useCallback } from "react";
import { listen } from "../../lib/electron";
import { AlertTriangleIcon, CheckIcon, CloseIcon, HammerIcon } from "../../lib/icons";

interface BuildTask {
  id: string;
  label: string;
  phase: "checking" | "deps" | "binary" | "done" | "error";
  message: string;
  detail?: string;
}

/**
 * Startup status bar — shows background build/setup tasks at the bottom of the app.
 *
 * Listens for `freerdp:build-progress` events and displays a compact status bar
 * while builds are in progress. Auto-dismisses after completion.
 */
export default function StartupStatus() {
  const [tasks, setTasks] = useState<Map<string, BuildTask>>(new Map());
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const unlistenFreerdp = listen<{
      phase: BuildTask["phase"];
      message: string;
      detail?: string;
    }>("freerdp:build-progress", (event) => {
      const { phase, message, detail } = event.payload;

      // Don't surface the "done" state if binary was already available (no build happened)
      // The checking phase is very brief; skip it to avoid flicker
      if (phase === "checking") return;

      setDismissed(false);
      setTasks((prev) => {
        const next = new Map(prev);
        next.set("freerdp", {
          id: "freerdp",
          label: "FreeRDP Helper",
          phase,
          message,
          detail,
        });
        return next;
      });

      // Auto-dismiss completed/error tasks after a delay
      if (phase === "done" || phase === "error") {
        setTimeout(() => {
          setTasks((prev) => {
            const next = new Map(prev);
            next.delete("freerdp");
            return next;
          });
        }, phase === "done" ? 4000 : 10000);
      }
    });

    return () => {
      unlistenFreerdp.then((fn) => fn());
    };
  }, []);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  if (dismissed || tasks.size === 0) return null;

  // Show the most active task (prefer in-progress over done/error)
  const activeTasks = Array.from(tasks.values());
  const current =
    activeTasks.find((t) => t.phase === "deps" || t.phase === "binary") ??
    activeTasks.find((t) => t.phase === "error") ??
    activeTasks[0];

  if (!current) return null;

  const isBuilding = current.phase === "deps" || current.phase === "binary";
  const isDone = current.phase === "done";
  const isError = current.phase === "error";

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-panel border-t border-stroke text-xs flex-shrink-0">
      {/* Icon */}
      {isBuilding && (
        <HammerIcon size={14} className="text-conduit-400 animate-pulse flex-shrink-0" />
      )}
      {isDone && (
        <CheckIcon size={14} className="text-green-400 flex-shrink-0" />
      )}
      {isError && (
        <AlertTriangleIcon size={14} className="text-red-400 flex-shrink-0" />
      )}

      {/* Label */}
      <span className="text-ink-muted flex-shrink-0">
        {current.label}:
      </span>

      {/* Message */}
      <span className={`truncate ${isError ? "text-red-400" : isDone ? "text-green-400" : "text-ink-secondary"}`}>
        {current.message}
      </span>

      {/* Detail (build output line) */}
      {isBuilding && current.detail && (
        <span className="text-ink-muted truncate hidden sm:inline">
          — {current.detail}
        </span>
      )}

      {/* Indeterminate progress bar */}
      {isBuilding && (
        <div className="flex-1 min-w-16 max-w-48 h-1 bg-raised rounded-full overflow-hidden ml-auto">
          <div className="h-full w-1/3 bg-conduit-500 rounded-full animate-indeterminate" />
        </div>
      )}

      {/* Dismiss */}
      <button
        onClick={handleDismiss}
        className="p-0.5 hover:bg-raised rounded flex-shrink-0 ml-auto text-ink-muted"
        title="Dismiss"
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
