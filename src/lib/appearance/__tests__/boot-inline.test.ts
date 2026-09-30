import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APPEARANCE_BOOT_MARKER, injectBootScript, loadBootScript, renderBootScript } from "../bootScript.mjs";
import TABLE from "../migration-table.json";
import SHELL_COLORS from "../shell-colors.json";

interface BootOptions {
  storage?: Record<string, string>;
  electron?: Record<string, unknown>;
  prefersDark?: boolean;
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const root = document.documentElement;
const originalUserAgent = navigator.userAgent;

function resetRoot(): void {
  root.className = "";
  for (const name of ["data-scheme", "data-os"]) root.removeAttribute(name);
  root.removeAttribute("style");
}

function runBoot({ storage = {}, electron, prefersDark = true }: BootOptions = {}): void {
  localStorage.clear();
  for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  (window as unknown as { electron?: unknown }).electron = electron;
  window.matchMedia = vi.fn((query: string) => ({
    matches: query === "(prefers-color-scheme: dark)" ? prefersDark : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  new Function(loadBootScript())();
}

function setUserAgent(value: string): void {
  Object.defineProperty(window.navigator, "userAgent", { value, configurable: true });
}

beforeEach(resetRoot);
afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
  setUserAgent(originalUserAgent);
  vi.restoreAllMocks();
});

describe("boot-inline.js", () => {
  it("migrates a retired macOS theme and sets every attribute before first paint", () => {
    runBoot({
      storage: { "conduit-theme": "dark", "conduit-platform-theme": "macos", "conduit-color-scheme": "macos-blue" },
      electron: { platform: "darwin", zoomFactor: () => 1.25 },
    });
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.classList.contains("light")).toBe(false);
    expect(root.getAttribute("data-scheme")).toBe("modern");
    expect(root.getAttribute("data-os")).toBe("macos");
    expect(root.style.getPropertyValue("--c-boot-bg")).toBe(SHELL_COLORS.modern.dark.shell);
    expect(root.style.getPropertyValue("--c-boot-fg")).toBe(SHELL_COLORS.modern.dark.fg);
    expect(localStorage.getItem("conduit-platform-theme")).toBeNull();
    expect(localStorage.getItem("conduit-color-scheme")).toBe("modern");
    expect(localStorage.getItem("conduit-icon-pack")).toBe("phosphor");
    expect(localStorage.getItem("conduit-appearance-version")).toBe("2");
  });

  it("sets no density and no counter-zoom (D-7, D-8)", () => {
    runBoot({ storage: { "conduit-density": "compact" }, electron: { platform: "darwin", zoomFactor: () => 1.25 } });
    expect(root.hasAttribute("data-density")).toBe(false);
    expect(root.style.getPropertyValue("--c-zoom")).toBe("");
    expect(localStorage.getItem("conduit-density")).toBeNull();
  });

  it("sets data-scheme even for Modern and follows the system mode", () => {
    root.classList.add("dark");
    runBoot({ storage: { "conduit-theme": "system" }, prefersDark: false, electron: { platform: "win32" } });
    expect(root.className).toBe("light");
    expect(root.getAttribute("data-scheme")).toBe("modern");
    expect(root.getAttribute("data-os")).toBe("windows");
    expect(root.style.getPropertyValue("--c-boot-bg")).toBe(SHELL_COLORS.modern.light.shell);
    expect(root.style.getPropertyValue("--c-boot-fg")).toBe("#6B6B6B");
  });

  it("a fresh profile (empty storage) resolves the system mode, Modern and Lucide", () => {
    runBoot({ prefersDark: true, electron: { platform: "linux" } });
    expect(root.className).toBe("dark");
    expect(root.getAttribute("data-os")).toBe("linux");
    expect(localStorage.getItem("conduit-color-scheme")).toBe("modern");
    expect(localStorage.getItem("conduit-icon-pack")).toBe("lucide");
    expect(localStorage.getItem("conduit-theme")).toBe("system");
  });

  it("keeps a migrated choice and applies the scheme's boot colors", () => {
    runBoot({
      storage: { "conduit-theme": "light", "conduit-color-scheme": "forest", "conduit-appearance-version": "2", "conduit-icon-pack": "hugeicons" },
    });
    expect(root.getAttribute("data-scheme")).toBe("forest");
    expect(root.style.getPropertyValue("--c-boot-bg")).toBe(SHELL_COLORS.forest.light.shell);
    expect(root.style.getPropertyValue("--c-boot-fg")).toBe(SHELL_COLORS.forest.light.fg);
    expect(localStorage.getItem("conduit-icon-pack")).toBe("hugeicons");
  });

  it("turns a stored codicons into Lucide and maps a retired scheme in a version-2 profile", () => {
    runBoot({ storage: { "conduit-appearance-version": "2", "conduit-icon-pack": "codicons", "conduit-color-scheme": "ubuntu-yaru" } });
    expect(localStorage.getItem("conduit-icon-pack")).toBe("lucide");
    expect(root.getAttribute("data-scheme")).toBe("ember");
  });

  it("keeps a newer appearance version instead of writing 2 over it", () => {
    runBoot({ storage: { "conduit-appearance-version": "3", "conduit-color-scheme": "rose" } });
    expect(root.getAttribute("data-scheme")).toBe("rose");
    expect(localStorage.getItem("conduit-appearance-version")).toBe("3");
  });

  it("falls back to the user agent for data-os", () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    runBoot();
    expect(root.getAttribute("data-os")).toBe("windows");
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    runBoot();
    expect(root.getAttribute("data-os")).toBe("macos");
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64)");
    runBoot();
    expect(root.getAttribute("data-os")).toBe("linux");
  });

  it("an unknown theme value falls back to system and is repaired", () => {
    runBoot({ storage: { "conduit-theme": "sepia" }, prefersDark: false });
    expect(root.className).toBe("light");
    expect(localStorage.getItem("conduit-theme")).toBe("system");
  });

  it("still paints when localStorage throws, and says why", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    runBoot({ prefersDark: true });
    expect(root.className).toBe("dark");
    expect(root.getAttribute("data-scheme")).toBe("modern");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[appearance boot]"), expect.any(Error));
  });
});

describe("conduitAppearanceBoot template", () => {
  it("inlines both tables and leaves no placeholder", () => {
    const script = loadBootScript();
    expect(script).not.toMatch(/__CONDUIT_[A-Z_]+__/);
    expect(script).toContain(JSON.stringify(TABLE.retiredSchemes));
    expect(script).toContain("conduit-appearance-version");
  });

  it("escapes markup in the inlined JSON", () => {
    const script = renderBootScript("var T = __CONDUIT_MIGRATION_TABLE__; var S = __CONDUIT_SHELL_COLORS__;", { a: "</script><!--" }, {});
    expect(script).not.toContain("</script>");
    expect(script).not.toContain("<!--");
    expect(new Function(`${script}; return T.a;`)()).toBe("</script><!--");
  });

  it("fails loudly when a placeholder is missing", () => {
    expect(() => renderBootScript("var T = 1;", {}, {})).toThrow(/__CONDUIT_MIGRATION_TABLE__/);
  });

  it("replaces the marker once and refuses a page without it", () => {
    const html = `<head>${APPEARANCE_BOOT_MARKER}<style></style></head>`;
    expect(injectBootScript(html, "var x = 1;", "index.html")).toBe("<head><script>var x = 1;</script><style></style></head>");
    expect(() => injectBootScript("<head></head>", "x", "gallery.html")).toThrow(/gallery\.html/);
  });
});

describe("HTML shells", () => {
  const readShell = (name: string) => fs.readFileSync(path.join(REPO, name), "utf8");

  it.each(["index.html", "overlay.html", "picker.html"])("%s carries the boot marker once and no hand-copied boot script", (name) => {
    const html = readShell(name);
    expect(html.split(APPEARANCE_BOOT_MARKER).length - 1).toBe(1);
    expect(html).not.toMatch(/localStorage|data-platform|data-scheme/);
    expect(injectBootScript(html, loadBootScript(), name)).toContain("conduit-appearance-version");
  });

  it("the splash takes its colors from the boot tokens", () => {
    const html = readShell("index.html");
    expect(html).toContain("background: var(--c-boot-bg)");
    expect(html).toContain("border-top-color: var(--c-boot-fg)");
    expect(html).not.toMatch(/#0f172a|#f8fafc|#38bdf8|#0ea5e9/);
  });
});
