import { useEffect, useState } from "react";
import { useSessionStore } from "../../../stores/sessionStore";

/** `value`, updated `delayMs` after it last changed; the first render returns it at once. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (Object.is(value, debounced)) return;
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, debounced, delayMs]);
  return debounced;
}

/** A key that changes `delayMs` after the set of open session ids changes. */
export function useSessionIdsKey(delayMs: number): string {
  const key = useSessionStore((s) => s.sessions.map((x) => x.id).sort().join("\n"));
  return useDebounced(key, delayMs);
}
