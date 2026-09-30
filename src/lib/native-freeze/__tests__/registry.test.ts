import { describe, it, expect, vi, afterEach } from "vitest";
import { createFreezeRegistry } from "../registry";
import { acquireFreeze, freezeHolders, isFrozen, subscribe } from "..";

const flushMicrotasks = () => Promise.resolve();

describe("createFreezeRegistry", () => {
  it("stays frozen until every holder has released", () => {
    const registry = createFreezeRegistry();
    expect(registry.isFrozen()).toBe(false);
    const releaseDialog = registry.acquire("dialog");
    const releaseDrag = registry.acquire("drag");
    expect(registry.isFrozen()).toBe(true);
    releaseDialog();
    expect(registry.isFrozen()).toBe(true);
    releaseDrag();
    expect(registry.isFrozen()).toBe(false);
  });

  it("counts two holders with the same reason separately", () => {
    const registry = createFreezeRegistry();
    const first = registry.acquire("dialog", "Unlock");
    const second = registry.acquire("dialog", "Unlock");
    first();
    expect(registry.isFrozen()).toBe(true);
    second();
    expect(registry.isFrozen()).toBe(false);
  });

  it("ignores a second call to the same release", () => {
    const registry = createFreezeRegistry();
    const release = registry.acquire("popover");
    const other = registry.acquire("menu");
    release();
    release();
    expect(registry.isFrozen()).toBe(true);
    expect(registry.holders().map((h) => h.reason)).toEqual(["menu"]);
    other();
    expect(registry.isFrozen()).toBe(false);
  });

  it("lists holders with reason, label and the time they started", () => {
    let clock = 1000;
    const registry = createFreezeRegistry({ now: () => clock });
    const releaseSidebar = registry.acquire("sidebar");
    clock = 2500;
    registry.acquire("dialog", "Take over this vault?");
    expect(registry.holders()).toEqual([
      { reason: "sidebar", label: undefined, since: 1000 },
      { reason: "dialog", label: "Take over this vault?", since: 2500 },
    ]);
    releaseSidebar();
    expect(registry.holders()).toEqual([{ reason: "dialog", label: "Take over this vault?", since: 2500 }]);
  });

  it("returns a snapshot that later changes do not alter", () => {
    const registry = createFreezeRegistry();
    const release = registry.acquire("drag");
    const before = registry.holders();
    release();
    expect(before).toHaveLength(1);
    expect(registry.holders()).toHaveLength(0);
    expect(Object.isFrozen(before[0])).toBe(true);
  });

  it("notifies subscribers once per microtask batch", async () => {
    const registry = createFreezeRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const a = registry.acquire("dialog");
    const b = registry.acquire("legacy");
    registry.acquire("drag");
    a();
    b();
    expect(listener).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies again for changes after a flush", async () => {
    const registry = createFreezeRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const release = registry.acquire("dialog");
    await flushMicrotasks();
    release();
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not notify for an idempotent second release", async () => {
    const registry = createFreezeRegistry();
    const release = registry.acquire("dialog");
    release();
    await flushMicrotasks();
    const listener = vi.fn();
    registry.subscribe(listener);
    release();
    await flushMicrotasks();
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", async () => {
    const registry = createFreezeRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    unsubscribe();
    registry.acquire("dialog");
    await flushMicrotasks();
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps notifying other subscribers when one throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = createFreezeRegistry();
    const good = vi.fn();
    registry.subscribe(() => {
      throw new Error("boom");
    });
    registry.subscribe(good);
    registry.acquire("dialog");
    await flushMicrotasks();
    expect(good).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("uses the injected scheduler for notifications", () => {
    const queued: Array<() => void> = [];
    const registry = createFreezeRegistry({ schedule: (flush) => queued.push(flush) });
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.acquire("dialog");
    registry.acquire("drag");
    expect(queued).toHaveLength(1);
    queued[0]();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("module singleton", () => {
  afterEach(() => {
    expect(freezeHolders()).toEqual([]);
  });

  it("exposes the shared registry", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    expect(isFrozen()).toBe(false);
    const release = acquireFreeze("dialog", "Settings");
    expect(isFrozen()).toBe(true);
    expect(freezeHolders()).toEqual([expect.objectContaining({ reason: "dialog", label: "Settings" })]);
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);
    release();
    expect(isFrozen()).toBe(false);
    unsubscribe();
  });

  it("publishes freezeHolders on window in development", () => {
    expect(import.meta.env.DEV).toBe(true);
    expect(window.__conduitFreeze).toBe(freezeHolders);
  });
});
