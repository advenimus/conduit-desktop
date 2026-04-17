import { useEffect, useState, useCallback, useRef } from "react";
import type { SerializedToast, SerializedToastAction } from "../../types/toast";

export type ToastType = "success" | "error" | "warning" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "default";
}

export interface ToastProgress {
  percent: number;       // 0-100
  leftLabel?: string;    // e.g. "File 1/3 — Downloading"
  rightLabel?: string;   // e.g. "2.4 MB / 12.5 MB"
  speed?: string;        // e.g. "5.2 MB/s"
}

export interface ToastOptions {
  message?: string;
  actions?: ToastAction[];
  persistent?: boolean;
  duration?: number;
  dismissOnAction?: boolean;
  progress?: ToastProgress;
}

interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  actions?: ToastAction[];
  persistent?: boolean;
  dismissOnAction: boolean;
  exiting?: boolean;
  progress?: ToastProgress;
}

type ToastParam = string | ToastOptions | undefined;
type ToastInput = Omit<ToastItem, "id" | "exiting"> & { duration?: number };

function buildToast(type: ToastType, title: string, param?: ToastParam): ToastInput {
  if (param === undefined || typeof param === "string") {
    return { type, title, message: param, dismissOnAction: true };
  }
  return {
    type,
    title,
    message: param.message,
    actions: param.actions,
    persistent: param.persistent,
    duration: param.duration,
    dismissOnAction: param.dismissOnAction ?? true,
    progress: param.progress,
  };
}

type ToastAddFn = (toast: ToastInput) => string;
type ToastRemoveFn = (id: string) => void;
type ToastUpdateFn = (id: string, partial: Partial<Pick<ToastItem, "title" | "message" | "progress" | "actions">>) => void;

// Module-level functions, set by the ToastController
let addFn: ToastAddFn = () => "";
let removeFn: ToastRemoveFn = () => {};
let updateFn: ToastUpdateFn = () => {};

// Module-level callback map: "toastId:actionIndex" → onClick closure
const actionCallbacks = new Map<string, () => void>();
// Module-level map: toastId → dismissOnAction flag
const dismissOnActionMap = new Map<string, boolean>();

// Public API for adding toasts from anywhere
export const toast = {
  success: (title: string, messageOrOptions?: ToastParam) =>
    addFn(buildToast("success", title, messageOrOptions)),
  error: (title: string, messageOrOptions?: ToastParam) =>
    addFn(buildToast("error", title, messageOrOptions)),
  warning: (title: string, messageOrOptions?: ToastParam) =>
    addFn(buildToast("warning", title, messageOrOptions)),
  info: (title: string, messageOrOptions?: ToastParam) =>
    addFn(buildToast("info", title, messageOrOptions)),
  dismiss: (id: string) => removeFn(id),
  update: (id: string, partial: Partial<Pick<ToastItem, "title" | "message" | "progress" | "actions">>) => updateFn(id, partial),
};

const MAX_VISIBLE = 5;

/** Serialize toasts for IPC to the overlay window */
function serializeToasts(toasts: ToastItem[]): SerializedToast[] {
  return toasts.map((t) => {
    let serializedActions: SerializedToastAction[] | undefined;
    if (t.actions && t.actions.length > 0) {
      serializedActions = t.actions.map((action, i) => {
        const actionId = `${t.id}:${i}`;
        actionCallbacks.set(actionId, action.onClick);
        return {
          id: actionId,
          label: action.label,
          variant: action.variant,
        };
      });
    }
    dismissOnActionMap.set(t.id, t.dismissOnAction);
    return {
      id: t.id,
      type: t.type,
      title: t.title,
      message: t.message,
      actions: serializedActions,
      persistent: t.persistent,
      exiting: t.exiting,
      progress: t.progress,
    };
  });
}

/** Push current overlay state to the overlay window via IPC */
let pushOverlayState: ((toasts: SerializedToast[]) => void) | null = null;

export function setPushOverlayState(fn: (toasts: SerializedToast[]) => void): void {
  pushOverlayState = fn;
}

/**
 * State-only toast controller — manages toast lifecycle and pushes serialized
 * state to the overlay window via IPC. Renders nothing to DOM.
 */
export function ToastController() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    // Clear any pending auto-dismiss timer
    const existing = timersRef.current.get(id);
    if (existing) {
      clearTimeout(existing);
      timersRef.current.delete(id);
    }

    // Start exit animation
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));

    // Remove after animation completes
    const animTimer = setTimeout(() => {
      timersRef.current.delete(`anim:${id}`);
      if (mountedRef.current) {
        setToasts((prev) => {
          const next = prev.filter((t) => t.id !== id);
          // Clean up action callbacks for this toast
          for (const key of actionCallbacks.keys()) {
            if (key.startsWith(`${id}:`)) {
              actionCallbacks.delete(key);
            }
          }
          dismissOnActionMap.delete(id);
          return next;
        });
      }
    }, 200);
    timersRef.current.set(`anim:${id}`, animTimer);
  }, []);

  const add = useCallback((input: ToastInput): string => {
    const id = crypto.randomUUID();
    const { duration, ...rest } = input;
    let overflowId: string | undefined;

    setToasts((prev) => {
      const next = [...prev, { ...rest, id, exiting: false }];
      // Cap visible toasts — find oldest non-persistent to dismiss
      if (next.filter((t) => !t.exiting).length > MAX_VISIBLE) {
        const oldest = next.find((t) => !t.persistent && !t.exiting);
        if (oldest) {
          overflowId = oldest.id;
        }
      }
      return next;
    });

    // Dismiss overflow outside state updater to avoid side effects in updater
    if (overflowId) {
      dismiss(overflowId);
    }

    if (!input.persistent) {
      const ms = duration ?? 5000;
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        dismiss(id);
      }, ms);
      timersRef.current.set(id, timer);
    }

    return id;
  }, [dismiss]);

  const update = useCallback((id: string, partial: Partial<Pick<ToastItem, "title" | "message" | "progress" | "actions">>) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, ...partial } : t)));
  }, []);

  // Register the global functions
  useEffect(() => {
    addFn = add;
    removeFn = dismiss;
    updateFn = update;
    return () => {
      addFn = () => "";
      removeFn = () => {};
      updateFn = () => {};
    };
  }, [add, dismiss, update]);

  // Push serialized state to overlay whenever toasts change
  useEffect(() => {
    const serialized = serializeToasts(toasts);
    pushOverlayState?.(serialized);
  }, [toasts]);

  // Listen for action callbacks from the overlay window
  useEffect(() => {
    const unlisten = window.electron.on("overlay:action-clicked", (data: unknown) => {
      const { actionId } = data as { actionId: string };
      const callback = actionCallbacks.get(actionId);
      if (callback) {
        callback();
        // Check if this toast should auto-dismiss on action
        const toastId = actionId.split(":")[0];
        if (dismissOnActionMap.get(toastId)) {
          dismiss(toastId);
        }
      }
    });
    return () => { unlisten(); };
  }, [dismiss]);

  // Listen for dismiss requests from the overlay window
  useEffect(() => {
    const unlisten = window.electron.on("overlay:dismiss-toast", (data: unknown) => {
      const { toastId } = data as { toastId: string };
      dismiss(toastId);
    });
    return () => { unlisten(); };
  }, [dismiss]);

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  // State-only controller — renders nothing
  return null;
}

// Keep ToastContainer as an alias for backward compatibility during transition
export const ToastContainer = ToastController;
