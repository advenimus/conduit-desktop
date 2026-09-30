import { useCallback, useEffect, useRef, useState } from "react";
import { dashboardApi } from "../../../lib/dashboardApi";
import { REACHABILITY_MAX_CONCURRENT, type ReachabilityResult } from "../../../types/dashboard";
import { runLimited } from "./runLimited";

export type ReachabilityResults = Readonly<Record<string, ReachabilityResult>>;

export interface UseReachability {
  /** The last result per entry id, kept while the view is mounted. */
  readonly results: ReachabilityResults;
  /** Entry ids with a check in flight. */
  readonly checking: ReadonlySet<string>;
  /** Resolves with the result, or null when the check failed (logged, never toasted). */
  check(entryId: string): Promise<ReachabilityResult | null>;
  /** Checks in order, four at a time; `onProgress` gets the settled count after each one. */
  checkMany(entryIds: readonly string[], onProgress?: (done: number, total: number) => void): Promise<void>;
}

const withId = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => new Set([...set, id]);
const withoutId = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

export function useReachability(): UseReachability {
  const [results, setResults] = useState<ReachabilityResults>({});
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set());
  const mounted = useRef(true);
  const inFlight = useRef(new Map<string, Promise<ReachabilityResult | null>>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const check = useCallback((entryId: string): Promise<ReachabilityResult | null> => {
    const running = inFlight.current.get(entryId);
    if (running) return running;
    setChecking((prev) => withId(prev, entryId));
    const promise = dashboardApi
      .checkReachability({ entryId })
      .then((result) => {
        if (mounted.current) setResults((prev) => ({ ...prev, [entryId]: result }));
        return result;
      })
      .catch((err: unknown) => {
        console.warn("reachability_check failed", err);
        return null;
      })
      .finally(() => {
        inFlight.current.delete(entryId);
        if (mounted.current) setChecking((prev) => withoutId(prev, entryId));
      });
    inFlight.current.set(entryId, promise);
    return promise;
  }, []);

  const checkMany = useCallback(
    async (entryIds: readonly string[], onProgress?: (done: number, total: number) => void) => {
      let done = 0;
      onProgress?.(0, entryIds.length);
      await runLimited(entryIds, REACHABILITY_MAX_CONCURRENT, async (id) => {
        await check(id);
        done += 1;
        onProgress?.(done, entryIds.length);
      });
    },
    [check],
  );

  return { results, checking, check, checkMany };
}
