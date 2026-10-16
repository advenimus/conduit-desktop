import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../../lib/electron", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

async function loadStore(settings: Record<string, unknown>) {
  vi.resetModules();
  invoke.mockReset();
  invoke.mockResolvedValue(settings);
  const { useSettingsStore } = await import("../settingsStore");
  await useSettingsStore.getState().refresh();
  return useSettingsStore.getState();
}

describe("settingsStore terminal font", () => {
  beforeEach(() => invoke.mockReset());

  it("keeps a saved font name", async () => {
    const state = await loadStore({ session_defaults_terminal: { fontSize: 15, fontFamily: "Maple Mono NF" } });
    expect(state.sessionDefaultsTerminal).toEqual({ fontSize: 15, scrollback: 10000, cursorBlink: true, fontFamily: "Maple Mono NF" });
  });

  it("uses the built-in fonts when the saved name is unsafe or missing", async () => {
    expect((await loadStore({ session_defaults_terminal: { fontFamily: 'x", y' } })).sessionDefaultsTerminal.fontFamily).toBe("");
    expect((await loadStore({ session_defaults_terminal: { fontSize: 12 } })).sessionDefaultsTerminal.fontFamily).toBe("");
    expect((await loadStore({})).sessionDefaultsTerminal.fontFamily).toBe("");
  });
});
