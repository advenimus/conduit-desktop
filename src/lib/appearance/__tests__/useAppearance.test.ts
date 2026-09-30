import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { APPEARANCE_APPLIED_EVENT, useAppearance, type AppearanceAppliedDetail } from "../useAppearance";
import { writeStoredAppearance } from "../dom";
import { useIconPackStore } from "../../icons";

const root = document.documentElement;
let mediaListeners: Array<() => void> = [];
let systemDark = true;

function installMatchMedia(): void {
  window.matchMedia = vi.fn((query: string) => ({
    get matches() {
      return query === "(prefers-color-scheme: dark)" ? systemDark : false;
    },
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: (_type: string, listener: () => void) => mediaListeners.push(listener),
    removeEventListener: (_type: string, listener: () => void) => {
      mediaListeners = mediaListeners.filter((l) => l !== listener);
    },
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function installBridge(settings: Record<string, unknown> | Error = {}) {
  const bridge = {
    platform: "darwin",
    invoke: vi.fn((channel: string) => {
      if (channel !== "settings_get") return Promise.reject(new Error(`unexpected ${channel}`));
      return settings instanceof Error ? Promise.reject(settings) : Promise.resolve(settings);
    }),
    send: vi.fn(),
    on: vi.fn(() => () => undefined),
    removeListener: vi.fn(),
  };
  (window as unknown as { electron: unknown }).electron = bridge;
  return bridge;
}

function themeChange(detail: Record<string, unknown>): void {
  act(() => {
    document.dispatchEvent(new CustomEvent("conduit:theme-change", { detail }));
  });
}

beforeEach(() => {
  localStorage.clear();
  root.className = "";
  for (const name of ["data-scheme", "data-os"]) root.removeAttribute(name);
  systemDark = true;
  mediaListeners = [];
  installMatchMedia();
});

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
  vi.restoreAllMocks();
});

describe("useAppearance", () => {
  it("applies the migrated storage on mount and mirrors it back", async () => {
    localStorage.setItem("conduit-theme", "light");
    localStorage.setItem("conduit-platform-theme", "windows");
    localStorage.setItem("conduit-color-scheme", "rose");
    const bridge = installBridge({ theme: "light", color_scheme: "rose", icon_pack: "fluent" });
    const { result } = renderHook(() => useAppearance());
    expect(result.current).toMatchObject({ theme: "light", scheme: "rose", iconPack: "fluent", mode: "light" });
    expect(result.current).not.toHaveProperty("density");
    expect(root.className).toBe("light");
    expect(root.getAttribute("data-scheme")).toBe("rose");
    expect(root.hasAttribute("data-density")).toBe(false);
    expect(localStorage.getItem("conduit-platform-theme")).toBeNull();
    expect(localStorage.getItem("conduit-icon-pack")).toBe("fluent");
    expect(bridge.send).toHaveBeenCalledWith("set-native-theme", "light");
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("settings_get", undefined));
  });

  it("dispatches conduit:appearance-applied after the attributes are set, with no density", () => {
    installBridge({});
    const seen: Array<{ detail: AppearanceAppliedDetail; scheme: string | null; dark: boolean }> = [];
    const listener = (e: Event) => {
      seen.push({
        detail: (e as CustomEvent<AppearanceAppliedDetail>).detail,
        scheme: root.getAttribute("data-scheme"),
        dark: root.classList.contains("dark"),
      });
    };
    document.addEventListener(APPEARANCE_APPLIED_EVENT, listener);
    renderHook(() => useAppearance());
    themeChange({ colorScheme: "forest", theme: "dark" });
    document.removeEventListener(APPEARANCE_APPLIED_EVENT, listener);

    const last = seen[seen.length - 1];
    expect(last.detail).toEqual({ scheme: "forest", mode: "dark", iconPack: "lucide" });
    expect(last).toMatchObject({ scheme: "forest", dark: true });
    for (const entry of seen) expect(entry.scheme).toBe(entry.detail.scheme);
  });

  it("follows conduit:theme-change for every key and ignores unknown values", () => {
    installBridge({});
    const { result } = renderHook(() => useAppearance());
    themeChange({ theme: "light", colorScheme: "midnight", iconPack: "hugeicons" });
    expect(result.current).toMatchObject({ theme: "light", scheme: "midnight", iconPack: "hugeicons" });
    expect(localStorage.getItem("conduit-theme")).toBe("light");
    expect(localStorage.getItem("conduit-color-scheme")).toBe("midnight");
    expect(localStorage.getItem("conduit-icon-pack")).toBe("hugeicons");
    expect(localStorage.getItem("conduit-density")).toBeNull();
    expect(useIconPackStore.getState().requested).toBe("hugeicons");
    themeChange({ colorScheme: "macos-blue", density: "compact", theme: "sepia", iconPack: "codicons", platformTheme: "macos" });
    expect(result.current).toMatchObject({ theme: "light", scheme: "midnight", iconPack: "hugeicons" });
    expect(root.hasAttribute("data-platform")).toBe(false);
    expect(root.hasAttribute("data-density")).toBe(false);
  });

  it("dispatches conduit:resolved-theme-change for terminals", () => {
    installBridge({});
    const modes: string[] = [];
    const listener = (e: Event) => modes.push((e as CustomEvent<string>).detail);
    document.addEventListener("conduit:resolved-theme-change", listener);
    renderHook(() => useAppearance());
    themeChange({ theme: "light" });
    document.removeEventListener("conduit:resolved-theme-change", listener);
    expect(modes[0]).toBe("dark");
    expect(modes[modes.length - 1]).toBe("light");
  });

  it("follows the OS while the theme is system", () => {
    installBridge({});
    localStorage.setItem("conduit-theme", "system");
    const { result } = renderHook(() => useAppearance());
    expect(root.className).toBe("dark");
    act(() => {
      systemDark = false;
      mediaListeners.forEach((l) => l());
    });
    expect(result.current.mode).toBe("light");
    expect(root.className).toBe("light");
  });

  it("adopts the settings file when localStorage was cleared (the file wins)", async () => {
    installBridge({ theme: "light", color_scheme: "amethyst", icon_pack: "tabler" });
    const { result } = renderHook(() => useAppearance());
    await waitFor(() => expect(result.current.scheme).toBe("amethyst"));
    expect(result.current).toMatchObject({ theme: "light", iconPack: "tabler" });
    expect(root.getAttribute("data-scheme")).toBe("amethyst");
    expect(localStorage.getItem("conduit-color-scheme")).toBe("amethyst");
  });

  it("keeps storage values when the settings file holds unknown values or cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.setItem("conduit-color-scheme", "ember");
    localStorage.setItem("conduit-appearance-version", "2");
    installBridge(new Error("no handler"));
    const { result } = renderHook(() => useAppearance());
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(result.current.scheme).toBe("ember");

    installBridge({ color_scheme: "nope", theme: 3 });
    const second = renderHook(() => useAppearance());
    await waitFor(() => expect((window.electron.invoke as ReturnType<typeof vi.fn>)).toHaveBeenCalled());
    expect(second.result.current.scheme).toBe("ember");
  });

  it("works without the Electron bridge (tests, storybook-like pages)", () => {
    const { result } = renderHook(() => useAppearance());
    expect(result.current.scheme).toBe("modern");
    expect(root.getAttribute("data-scheme")).toBe("modern");
  });

  it("the storage mirror writes version 2 but never lowers a newer version", () => {
    const state = { theme: "dark", scheme: "ember", iconPack: "lucide" } as const;
    writeStoredAppearance(state);
    expect(localStorage.getItem("conduit-appearance-version")).toBe("2");
    localStorage.setItem("conduit-appearance-version", "3");
    writeStoredAppearance(state);
    expect(localStorage.getItem("conduit-appearance-version")).toBe("3");
  });
});
