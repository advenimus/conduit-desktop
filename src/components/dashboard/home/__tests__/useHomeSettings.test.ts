import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { DEFAULT_HOME_SETTINGS } from "../../../../types/dashboard";
import { parseHomeSettings, resetHomeSettings, useHomeSettings } from "../useHomeSettings";

describe("parseHomeSettings", () => {
  it("falls back to the defaults for missing or malformed values", () => {
    expect(parseHomeSettings(null)).toEqual(DEFAULT_HOME_SETTINGS);
    expect(parseHomeSettings("nope")).toEqual(DEFAULT_HOME_SETTINGS);
    expect(parseHomeSettings([1, 2])).toEqual(DEFAULT_HOME_SETTINGS);
    expect(parseHomeSettings({})).toEqual(DEFAULT_HOME_SETTINGS);
  });

  it("keeps valid fields and replaces bad ones field by field", () => {
    expect(parseHomeSettings({ hidden: ["favorites", "bogus", "quick", "favorites"], passwordAgeDays: 42, backupStaleDays: 14 })).toEqual({
      version: 1,
      hidden: ["quick", "favorites"],
      passwordAgeDays: 180,
      backupStaleDays: 14,
    });
    expect(parseHomeSettings({ hidden: "quick", passwordAgeDays: null, backupStaleDays: 5 })).toEqual({
      version: 1,
      hidden: [],
      passwordAgeDays: null,
      backupStaleDays: 7,
    });
    expect(parseHomeSettings({ passwordAgeDays: 365 }).passwordAgeDays).toBe(365);
    expect(parseHomeSettings({ passwordAgeDays: "90" }).passwordAgeDays).toBe(180);
  });
});

describe("useHomeSettings", () => {
  const invoke = vi.fn();

  beforeEach(() => {
    resetHomeSettings();
    invoke.mockReset();
    Object.assign(window, { electron: { invoke, on: () => () => undefined } });
  });

  afterEach(() => resetHomeSettings());

  it("reads the stored value once through ui_state_get", async () => {
    invoke.mockResolvedValue({ hidden: ["ai-activity"], passwordAgeDays: 90, backupStaleDays: 3 });
    const { result } = renderHook(() => useHomeSettings());
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.settings).toEqual({ version: 1, hidden: ["ai-activity"], passwordAgeDays: 90, backupStaleDays: 3 });
    expect(invoke).toHaveBeenCalledWith("ui_state_get", { key: "home-dashboard" });
    renderHook(() => useHomeSettings());
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("uses the defaults when the read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invoke.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useHomeSettings());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.settings).toEqual(DEFAULT_HOME_SETTINGS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("saves every change at once through ui_state_set", async () => {
    invoke.mockResolvedValue(null);
    const { result } = renderHook(() => useHomeSettings());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.update({ hidden: ["recent"] }));
    act(() => result.current.update({ backupStaleDays: 30 }));
    const expected = { version: 1, hidden: ["recent"], passwordAgeDays: 180, backupStaleDays: 30 };
    expect(result.current.settings).toEqual(expected);
    expect(invoke).toHaveBeenLastCalledWith("ui_state_set", { key: "home-dashboard", value: expected });
  });
});
