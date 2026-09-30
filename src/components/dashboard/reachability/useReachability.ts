import { useCallback, useMemo } from "react";
import { create } from "zustand";
import { dashboardApi } from "../../../lib/dashboardApi";
import { useEntryStore } from "../../../stores/entryStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { REACHABILITY_MAX_CONCURRENT, type ReachabilityResult } from "../../../types/dashboard";
import type { EntryMeta } from "../../../types/entry";
import { selectEntries } from "../home/storeSelectors";
import { runLimited } from "./runLimited";

export type ReachabilityResults = Readonly<Record<string, ReachabilityResult>>;

export interface UseReachability {
  /** The last result per entry id, shared by every view until the vault locks. */
  readonly results: ReachabilityResults;
  /** Entry ids with a check in flight. */
  readonly checking: ReadonlySet<string>;
  /** Resolves with the result, or null when the check failed (logged, never toasted). */
  check(entryId: string): Promise<ReachabilityResult | null>;
  /** Checks in order, four at a time; `onProgress` gets the settled count after each one. */
  checkMany(entryIds: readonly string[], onProgress?: (done: number, total: number) => void): Promise<void>;
}

interface StoredResult {
  readonly result: ReachabilityResult;
  /** The entry's type, host and port when the check started; null when the entry was not loaded. */
  readonly target: string | null;
}

interface ReachabilityState {
  readonly stored: Readonly<Record<string, StoredResult>>;
  readonly checking: ReadonlySet<string>;
}

const NO_CHECKS: ReadonlySet<string> = new Set();

// One cache for every view, so a split or a remounted tab keeps its "Is it up?" results.
const useReachabilityStore = create<ReachabilityState>(() => ({ stored: {}, checking: NO_CHECKS }));
const inFlight = new Map<string, Promise<ReachabilityResult | null>>();

const withId = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => new Set([...set, id]);
const withoutId = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

function targetOf(entry: Pick<EntryMeta, "entry_type" | "host" | "port"> | undefined): string | null {
  return entry ? JSON.stringify([entry.entry_type, entry.host ?? null, entry.port ?? null]) : null;
}

function currentTarget(entryId: string): string | null {
  return targetOf(selectEntries(useEntryStore.getState()).find((e) => e.id === entryId));
}

/** Forgets every result. Runs when the vault locks; tests call it too. */
export function resetReachabilityCache(): void {
  inFlight.clear();
  useReachabilityStore.setState({ stored: {}, checking: NO_CHECKS });
}

useVaultStore.subscribe((state, prev) => {
  if (prev.isUnlocked && !state.isUnlocked) resetReachabilityCache();
});

function checkEntry(entryId: string): Promise<ReachabilityResult | null> {
  const running = inFlight.get(entryId);
  if (running) return running;
  const target = currentTarget(entryId);
  useReachabilityStore.setState((s) => ({ checking: withId(s.checking, entryId) }));
  const promise = dashboardApi
    .checkReachability({ entryId })
    .then((result) => {
      if (inFlight.get(entryId) === promise) {
        useReachabilityStore.setState((s) => ({ stored: { ...s.stored, [entryId]: { result, target } } }));
      }
      return result;
    })
    .catch((err: unknown) => {
      console.warn("reachability_check failed", err);
      return null;
    })
    .finally(() => {
      if (inFlight.get(entryId) !== promise) return;
      inFlight.delete(entryId);
      useReachabilityStore.setState((s) => ({ checking: withoutId(s.checking, entryId) }));
    });
  inFlight.set(entryId, promise);
  return promise;
}

/** Results whose entry changed type, host or port since the check are dropped. */
function visibleResults(stored: ReachabilityState["stored"], entries: readonly EntryMeta[]): ReachabilityResults {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out: Record<string, ReachabilityResult> = {};
  for (const [id, { result, target }] of Object.entries(stored)) {
    if (target === targetOf(byId.get(id))) out[id] = result;
  }
  return out;
}

export function useReachability(): UseReachability {
  const stored = useReachabilityStore((s) => s.stored);
  const checking = useReachabilityStore((s) => s.checking);
  const entries = useEntryStore(selectEntries);
  const results = useMemo(() => visibleResults(stored, entries), [stored, entries]);

  const check = useCallback((entryId: string) => checkEntry(entryId), []);

  const checkMany = useCallback(
    async (entryIds: readonly string[], onProgress?: (done: number, total: number) => void) => {
      let done = 0;
      onProgress?.(0, entryIds.length);
      await runLimited(entryIds, REACHABILITY_MAX_CONCURRENT, async (id) => {
        await checkEntry(id);
        done += 1;
        onProgress?.(done, entryIds.length);
      });
    },
    [],
  );

  return { results, checking, check, checkMany };
}
