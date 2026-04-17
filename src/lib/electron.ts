/**
 * Electron IPC wrapper that matches the Tauri API surface.
 *
 * Components/stores import `invoke` and `listen` from this module
 * instead of from the Tauri API — the signatures are compatible
 * so the rest of the frontend code stays unchanged.
 */

/** Equivalent of Tauri's UnlistenFn */
export type UnlistenFn = () => void;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await window.electron.invoke(cmd, args) as T;
  } catch (err) {
    // Electron wraps IPC errors as "Error invoking remote method '...': Error: <msg>"
    // Strip the prefix so callers get the clean message.
    const raw = err instanceof Error ? err.message : String(err);
    const match = raw.match(/^Error invoking remote method '[^']+': (?:Error: )?(.+)$/s);
    throw new Error(match ? match[1] : raw);
  }
}

/**
 * Listen for events from the main process (async — Tauri-compatible).
 *
 * The handler receives `{ payload: T }` to match the Tauri Event shape,
 * so existing component code like `event.payload.sessionId` works as-is.
 *
 * NOTE: Prefer `listenSync` in React useEffect hooks to avoid cleanup race
 * conditions — the async wrapper delays the unlisten function by one microtask.
 */
export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<UnlistenFn> {
  return window.electron.on(event, (payload) =>
    handler({ payload: payload as T })
  );
}

/**
 * Synchronous variant of `listen` — returns the unlisten function immediately.
 *
 * Use this in React useEffect hooks so the cleanup function always has access
 * to the unlisten callback (no microtask delay from Promise resolution).
 */
export function listenSync<T>(
  event: string,
  handler: (event: { payload: T }) => void
): UnlistenFn {
  return window.electron.on(event, (payload) =>
    handler({ payload: payload as T })
  );
}
