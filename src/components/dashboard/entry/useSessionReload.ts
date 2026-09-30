import { useEffect, useRef } from "react";
import { useSessionStore } from "../../../stores/sessionStore";

export const SESSION_RELOAD_DELAY_MS = 750;

const sessionIdsKey = (s: ReturnType<typeof useSessionStore.getState>) =>
  s.sessions
    .map((session) => session.id)
    .sort()
    .join("\n");

/** Calls `load` on mount and whenever `reloadKey` changes, and 750 ms after the set of session ids changes (debounced). */
export function useSessionReload(load: () => void, reloadKey: string): void {
  const sessionsKey = useSessionStore(sessionIdsKey);
  const latest = useRef(load);
  const seenSessionsKey = useRef(sessionsKey);

  useEffect(() => {
    latest.current = load;
  });

  useEffect(() => {
    latest.current();
  }, [reloadKey]);

  useEffect(() => {
    if (sessionsKey === seenSessionsKey.current) return;
    seenSessionsKey.current = sessionsKey;
    const timer = setTimeout(() => latest.current(), SESSION_RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sessionsKey]);
}
