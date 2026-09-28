import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { acquireFreeze, freezeHolders, isFrozen, useFreeze, useIsFrozen, type FreezeReason } from "..";

afterEach(() => {
  cleanup();
  expect(freezeHolders()).toEqual([]);
});

describe("useFreeze", () => {
  it("holds a freeze only while active", () => {
    const hook = renderHook(({ active }) => useFreeze(active, "dialog", "Settings"), {
      initialProps: { active: false },
    });
    expect(isFrozen()).toBe(false);
    hook.rerender({ active: true });
    expect(freezeHolders()).toEqual([expect.objectContaining({ reason: "dialog", label: "Settings" })]);
    hook.rerender({ active: false });
    expect(isFrozen()).toBe(false);
  });

  it("releases on unmount", () => {
    const hook = renderHook(() => useFreeze(true, "sidebar"));
    expect(isFrozen()).toBe(true);
    hook.unmount();
    expect(isFrozen()).toBe(false);
  });

  it("swaps the holder when the reason or label changes", () => {
    const hook = renderHook(({ reason, label }: { reason: FreezeReason; label: string }) => useFreeze(true, reason, label), {
      initialProps: { reason: "dialog" as FreezeReason, label: "One" },
    });
    hook.rerender({ reason: "popover", label: "Two" });
    expect(freezeHolders()).toEqual([expect.objectContaining({ reason: "popover", label: "Two" })]);
    hook.unmount();
  });
});

describe("useIsFrozen", () => {
  it("follows the registry", async () => {
    const hook = renderHook(() => useIsFrozen());
    expect(hook.result.current).toBe(false);
    let release = () => {};
    await act(async () => {
      release = acquireFreeze("drag");
    });
    expect(hook.result.current).toBe(true);
    await act(async () => {
      release();
    });
    expect(hook.result.current).toBe(false);
  });

  it("sees a freeze held by another component", async () => {
    const reader = renderHook(() => useIsFrozen());
    const holder = renderHook(() => useFreeze(true, "dialog"));
    await act(async () => {});
    expect(reader.result.current).toBe(true);
    holder.unmount();
    await act(async () => {});
    expect(reader.result.current).toBe(false);
  });
});
