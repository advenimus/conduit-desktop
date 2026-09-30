import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReachabilityResult } from "../../../../types/dashboard";
import { resetReachabilityCache, useReachability } from "../useReachability";
import { useEntryStore } from "../../../../stores/entryStore";
import { useVaultStore } from "../../../../stores/vaultStore";
import type { EntryMeta } from "../../../../types/entry";

const checkReachability = vi.fn();
vi.mock("../../../../lib/dashboardApi", () => ({
  dashboardApi: { checkReachability: (...args: unknown[]) => checkReachability(...args) },
}));

const result = (entryId: string, status: ReachabilityResult["status"] = "reachable"): ReachabilityResult => ({
  entryId,
  status,
  host: "10.0.0.1",
  port: 22,
  latencyMs: status === "reachable" ? 12 : null,
  checkedAt: new Date().toISOString(),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  checkReachability.mockReset();
  resetReachabilityCache();
  useEntryStore.setState({ entries: [] });
});
afterEach(() => vi.restoreAllMocks());

describe("useReachability", () => {
  it("marks the entry as checking until the result arrives, then keeps the result", async () => {
    const pending = deferred<ReachabilityResult>();
    checkReachability.mockReturnValueOnce(pending.promise);
    const { result: hook } = renderHook(() => useReachability());

    let done!: Promise<ReachabilityResult | null>;
    act(() => {
      done = hook.current.check("a");
    });
    expect(hook.current.checking.has("a")).toBe(true);
    expect(checkReachability).toHaveBeenCalledWith({ entryId: "a" });

    await act(async () => {
      pending.resolve(result("a", "refused"));
      await done;
    });
    expect(hook.current.checking.has("a")).toBe(false);
    expect(hook.current.results.a.status).toBe("refused");
  });

  it("shares one call for an entry already in flight", async () => {
    const pending = deferred<ReachabilityResult>();
    checkReachability.mockReturnValueOnce(pending.promise);
    const { result: hook } = renderHook(() => useReachability());
    let first!: Promise<ReachabilityResult | null>;
    let second!: Promise<ReachabilityResult | null>;
    act(() => {
      first = hook.current.check("a");
      second = hook.current.check("a");
    });
    expect(first).toBe(second);
    expect(checkReachability).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(result("a"));
      await first;
    });
  });

  it("logs a failed check without a result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    checkReachability.mockRejectedValueOnce(new Error("Vault is locked"));
    const { result: hook } = renderHook(() => useReachability());
    let value: ReachabilityResult | null = result("x");
    await act(async () => {
      value = await hook.current.check("a");
    });
    expect(value).toBeNull();
    expect(hook.current.results.a).toBeUndefined();
    expect(hook.current.checking.size).toBe(0);
    expect(warn).toHaveBeenCalledWith("reachability_check failed", expect.any(Error));
  });

  it("checks many four at a time, in order, and reports progress", async () => {
    const calls: { id: string; resolve: (r: ReachabilityResult) => void }[] = [];
    checkReachability.mockImplementation(({ entryId }: { entryId: string }) => {
      const d = deferred<ReachabilityResult>();
      calls.push({ id: entryId, resolve: d.resolve });
      return d.promise;
    });
    const progress: [number, number][] = [];
    const { result: hook } = renderHook(() => useReachability());
    let run!: Promise<void>;
    act(() => {
      run = hook.current.checkMany(["a", "b", "c", "d", "e", "f"], (done, total) => progress.push([done, total]));
    });
    await act(async () => undefined);
    expect(calls.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);

    await act(async () => {
      calls[1].resolve(result("b"));
      await Promise.resolve();
    });
    await act(async () => undefined);
    expect(calls.map((c) => c.id)).toEqual(["a", "b", "c", "d", "e"]);

    await act(async () => {
      for (const c of calls) c.resolve(result(c.id));
      await new Promise((r) => setTimeout(r, 0));
      calls[5]?.resolve(result("f"));
      await run;
    });
    expect(calls.map((c) => c.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(progress[0]).toEqual([0, 6]);
    expect(progress[progress.length - 1]).toEqual([6, 6]);
    expect(Object.keys(hook.current.results).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("shares results between views, so a remounted tab keeps them", async () => {
    checkReachability.mockResolvedValueOnce(result("a", "timeout"));
    const first = renderHook(() => useReachability());
    await act(async () => {
      await first.result.current.check("a");
    });
    first.unmount();
    const second = renderHook(() => useReachability());
    expect(second.result.current.results.a.status).toBe("timeout");
    expect(checkReachability).toHaveBeenCalledTimes(1);
  });

  it("drops a result when the entry's host, port or type changes", async () => {
    const entry = { id: "a", name: "web-01", entry_type: "ssh", host: "old.example", port: 22 } as EntryMeta;
    useEntryStore.setState({ entries: [entry] });
    checkReachability.mockResolvedValueOnce(result("a"));
    const { result: hook } = renderHook(() => useReachability());
    await act(async () => {
      await hook.current.check("a");
    });
    expect(hook.current.results.a).toBeDefined();
    act(() => useEntryStore.setState({ entries: [{ ...entry, name: "renamed" }] }));
    expect(hook.current.results.a).toBeDefined();
    act(() => useEntryStore.setState({ entries: [{ ...entry, host: "new.example" }] }));
    expect(hook.current.results.a).toBeUndefined();
    act(() => useEntryStore.setState({ entries: [entry] }));
    expect(hook.current.results.a).toBeDefined();
    act(() => useEntryStore.setState({ entries: [{ ...entry, port: 2222 }] }));
    expect(hook.current.results.a).toBeUndefined();
  });

  it("forgets every result when the vault locks", async () => {
    act(() => useVaultStore.setState({ isUnlocked: true }));
    checkReachability.mockResolvedValueOnce(result("a"));
    const { result: hook } = renderHook(() => useReachability());
    await act(async () => {
      await hook.current.check("a");
    });
    expect(hook.current.results.a).toBeDefined();
    act(() => useVaultStore.setState({ isUnlocked: false }));
    expect(hook.current.results.a).toBeUndefined();
  });
});
