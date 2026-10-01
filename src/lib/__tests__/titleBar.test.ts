import { afterEach, describe, expect, it, vi } from "vitest";
import { hasInsetTitleBar, installTitleBar } from "../titleBar";

type Listener = (payload: unknown) => void;

function stubElectron(platform: string) {
  const listeners = new Map<string, Listener>();
  window.electron = {
    platform: platform as NodeJS.Platform,
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn((channel: string, cb: Listener) => {
      listeners.set(channel, cb);
      return () => listeners.delete(channel);
    }),
    removeListener: vi.fn(),
  };
  return listeners;
}

afterEach(() => {
  delete (window as Partial<Window>).electron;
});

describe("hasInsetTitleBar", () => {
  it("is on for macOS only", () => {
    expect(hasInsetTitleBar("darwin")).toBe(true);
    expect(hasInsetTitleBar("win32")).toBe(false);
    expect(hasInsetTitleBar("linux")).toBe(false);
    expect(hasInsetTitleBar(undefined)).toBe(false);
  });
});

describe("installTitleBar", () => {
  it("marks the root on macOS and follows full screen", () => {
    const listeners = stubElectron("darwin");
    const root = document.createElement("html");
    installTitleBar(root);
    expect(root.dataset.titlebar).toBe("inset");

    listeners.get("window-full-screen-changed")?.(true);
    expect(root.hasAttribute("data-fullscreen")).toBe(true);
    listeners.get("window-full-screen-changed")?.(false);
    expect(root.hasAttribute("data-fullscreen")).toBe(false);
  });

  it("leaves the root alone elsewhere", () => {
    const listeners = stubElectron("win32");
    const root = document.createElement("html");
    installTitleBar(root);
    expect(root.hasAttribute("data-titlebar")).toBe(false);
    expect(listeners.size).toBe(0);
  });
});
