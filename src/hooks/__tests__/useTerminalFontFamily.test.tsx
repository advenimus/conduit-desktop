import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

vi.mock("../../lib/electron", () => ({ invoke: vi.fn(async () => ({})) }));

import { applyTerminalFont, useTerminalFontFamily } from "../useTerminalFontFamily";
import { useSettingsStore } from "../../stores/settingsStore";
import { HARDCODED_TERMINAL_DEFAULTS } from "../../types/entry";
import { TERMINAL_FONT_FALLBACK } from "../../lib/terminalFont";

function fakeTerminal(fontFamily = TERMINAL_FONT_FALLBACK) {
  const term = { options: { fontFamily, fontSize: 14 }, clearTextureAtlas: vi.fn() };
  return term as typeof term & Terminal;
}

const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
let load: ReturnType<typeof vi.fn>;

beforeEach(() => {
  load = vi.fn(async () => []);
  Object.defineProperty(document, "fonts", { value: { load }, configurable: true });
  useSettingsStore.setState({ sessionDefaultsTerminal: { ...HARDCODED_TERMINAL_DEFAULTS } });
});

afterEach(() => {
  if (fontsDescriptor) Object.defineProperty(document, "fonts", fontsDescriptor);
  else delete (document as { fonts?: unknown }).fonts;
});

describe("applyTerminalFont", () => {
  it("loads the font, swaps it in, redraws the glyphs and refits", async () => {
    const term = fakeTerminal();
    const fit = vi.fn();
    await applyTerminalFont(term, "Maple Mono NF", fit);
    expect(load).toHaveBeenCalledWith('14px "Maple Mono NF"');
    expect(term.options.fontFamily).toBe(`"Maple Mono NF", ${TERMINAL_FONT_FALLBACK}`);
    expect(term.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("does not redraw the glyphs again when a remount applies the same font", async () => {
    const term = fakeTerminal(`"Maple Mono NF", ${TERMINAL_FONT_FALLBACK}`);
    const fit = vi.fn();
    await applyTerminalFont(term, "Maple Mono NF", fit);
    await applyTerminalFont(term, "Maple Mono NF", fit);
    expect(term.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the terminal already uses the built-in fonts", async () => {
    const term = fakeTerminal();
    const fit = vi.fn();
    await applyTerminalFont(term, "", fit);
    expect(term.clearTextureAtlas).not.toHaveBeenCalled();
    expect(fit).not.toHaveBeenCalled();
  });

  it("goes back to the built-in fonts when the setting is cleared", async () => {
    const term = fakeTerminal(`"Maple Mono NF", ${TERMINAL_FONT_FALLBACK}`);
    const fit = vi.fn();
    await applyTerminalFont(term, "", fit);
    expect(term.options.fontFamily).toBe(TERMINAL_FONT_FALLBACK);
    expect(fit).toHaveBeenCalled();
  });

  it("drops a change that a newer one replaced while the font loaded", async () => {
    const term = fakeTerminal();
    await applyTerminalFont(term, "Maple Mono NF", vi.fn(), () => true);
    expect(term.options.fontFamily).toBe(TERMINAL_FONT_FALLBACK);
    expect(term.clearTextureAtlas).not.toHaveBeenCalled();
  });

  it("logs instead of throwing when the terminal rejects the change", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const term = fakeTerminal();
    term.clearTextureAtlas.mockImplementation(() => {
      throw new Error("disposed");
    });
    await expect(applyTerminalFont(term, "Maple Mono NF", vi.fn())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("useTerminalFontFamily", () => {
  it("applies a saved setting change to an open terminal", async () => {
    const term = fakeTerminal();
    const fit = vi.fn();
    renderHook(() => useTerminalFontFamily(term, fit));
    expect(term.options.fontFamily).toBe(TERMINAL_FONT_FALLBACK);

    act(() => {
      useSettingsStore.setState({ sessionDefaultsTerminal: { ...HARDCODED_TERMINAL_DEFAULTS, fontFamily: "Maple Mono NF" } });
    });
    await waitFor(() => expect(term.options.fontFamily).toBe(`"Maple Mono NF", ${TERMINAL_FONT_FALLBACK}`));
    expect(term.clearTextureAtlas).toHaveBeenCalled();
    expect(fit).toHaveBeenCalled();
  });

  it("waits for a terminal to exist", () => {
    useSettingsStore.setState({ sessionDefaultsTerminal: { ...HARDCODED_TERMINAL_DEFAULTS, fontFamily: "Maple Mono NF" } });
    renderHook(() => useTerminalFontFamily(null, vi.fn()));
    expect(load).not.toHaveBeenCalled();
  });
});
