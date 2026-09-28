import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("../../lib/electron", () => ({ invoke }));

const icons = vi.hoisted(() => ({ fail: new Set<string>() }));
vi.mock("../../lib/icons", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/icons")>();
  return {
    ...actual,
    iconToSvg: (name: Parameters<typeof actual.iconToSvg>[0], size?: number) => {
      if (icons.fail.has(name)) throw new Error(`no ${name}`);
      return actual.iconToSvg(name, size);
    },
  };
});

import { iconToSvg, SEMANTIC_ICON_NAMES } from "../../lib/icons";
import { LEGACY_MENU_ICON_KEYS, menuIconName, showContextMenu, type PopupMenuItem } from "../contextMenu";

/** jsdom does not resolve var(); the probe's computed color is stubbed per token, as Chromium serializes it. */
const TOKENS: Record<string, string> = {
  "--c-overlay": "rgb(32, 33, 34)",
  "--c-overlay-border": "rgb(42, 43, 44)",
  "--c-ink-secondary": "rgb(191, 191, 191)",
  "--c-ink-muted": "rgb(157, 157, 157)",
  "--c-menu-selection-bg": "rgba(14, 165, 233, 0.15)",
  "--c-menu-selection-border": "color(srgb 0.054902 0.647059 0.913725)",
  "--c-danger": "rgb(244, 135, 113)",
  "--c-menu-danger-hover-bg": "color(srgb 0.956863 0.529412 0.443137 / 0.1)",
  "--c-divider": "rgb(42, 43, 44)",
  "--c-shell": "rgb(25, 26, 27)",
};

function stubTokens(tokens: Record<string, string>): void {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
    const style = (element as HTMLElement).style;
    const token = style?.color?.match(/^var\((--c-[\w-]+)\)$/)?.[1];
    if (!token) return real(element, pseudo);
    const inherited = (element.parentElement as HTMLElement | null)?.style.color || "rgb(0, 0, 0)";
    return { color: tokens[token] ?? inherited } as CSSStyleDeclaration;
  });
}

interface SentItem {
  id: string;
  label: string;
  type?: string;
  variant?: string;
  iconSvg?: string;
  icon?: string;
  children?: SentItem[];
}

function lastPayload(): { items: SentItem[]; colors: Record<string, string>; [key: string]: unknown } {
  expect(invoke).toHaveBeenCalled();
  const [channel, payload] = invoke.mock.calls[invoke.mock.calls.length - 1];
  expect(channel).toBe("show_context_menu_popup");
  return payload;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  icons.fail.clear();
  stubTokens(TOKENS);
  document.documentElement.classList.add("dark");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark", "light");
});

describe("menuIconName", () => {
  it.each([
    ["play", "playerPlay"],
    ["edit", "pencil"],
    ["rename", "textCursor"],
    ["copy", "copy"],
    ["copy-host", "server"],
    ["reconnect", "refresh"],
    ["connect", "link"],
    ["folder-plus", "folderPlus"],
    ["external-link", "externalLink"],
    ["dots", "ellipsis"],
    ["chevron-right", "chevronRight"],
    ["star-off", "starFilled"],
    ["split", null],
  ])("maps the old key %s to %s", (key, name) => {
    expect(menuIconName(key)).toBe(name);
  });

  it("keeps the distinctions today's menus draw between neighboring items", () => {
    expect(menuIconName("rename")).not.toBe(menuIconName("edit"));
    expect(menuIconName("copy-host")).not.toBe(menuIconName("copy"));
    expect(menuIconName("star-off")).not.toBe(menuIconName("star"));
  });

  it("keeps the old keys that were already semantic names", () => {
    for (const key of ["user", "key", "star", "trash", "plus", "folder", "close", "home", "terminal", "shield", "lock", "keyboard", "clock"]) {
      expect(menuIconName(key)).toBe(key);
    }
  });

  it("maps every old key to a semantic name and passes semantic names through", () => {
    for (const name of Object.values(LEGACY_MENU_ICON_KEYS)) if (name !== null) expect(SEMANTIC_ICON_NAMES).toContain(name);
    for (const name of SEMANTIC_ICON_NAMES) expect(menuIconName(name)).toBe(name);
  });

  it("returns null for an unknown key", () => {
    expect(menuIconName("nope")).toBeNull();
    expect(menuIconName("constructor")).toBeNull();
  });
});

describe("showContextMenu", () => {
  it("sends each item's icon as the active pack's 16px svg, for old keys and semantic names", async () => {
    const items: PopupMenuItem[] = [
      { id: "open", label: "Open Session", icon: "play" },
      { id: "split_right", label: "Split Right", icon: "splitHorizontal" },
      { id: "sep", label: "", type: "separator" },
      { id: "plain", label: "No icon" },
      { id: "delete", label: "Delete", variant: "danger", icon: "trash" },
    ];
    await showContextMenu(10, 20, items);
    const payload = lastPayload();
    expect(payload.items).toEqual([
      { id: "open", label: "Open Session", iconSvg: iconToSvg("playerPlay", 16) },
      { id: "split_right", label: "Split Right", iconSvg: iconToSvg("splitHorizontal", 16) },
      { id: "sep", label: "", type: "separator" },
      { id: "plain", label: "No icon" },
      { id: "delete", label: "Delete", variant: "danger", iconSvg: iconToSvg("trash", 16) },
    ]);
    expect(payload.items[0].iconSvg).toMatch(/^<svg[^>]* width="16" height="16"/);
    expect(payload).toMatchObject({ x: 10, y: 20, theme: "dark" });
    expect(payload).not.toHaveProperty("submenuIconSvg");
  });

  it("sends Split Right and Split Down without an icon, as today, and warns about nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await showContextMenu(0, 0, [
      { id: "split_right", label: "Split Right", icon: "split" },
      { id: "split_down", label: "Split Down", icon: "split" },
    ]);
    expect(lastPayload().items).toEqual([
      { id: "split_right", label: "Split Right" },
      { id: "split_down", label: "Split Down" },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("converts submenu children and sends the chevron for submenu rows", async () => {
    await showContextMenu(0, 0, [
      { id: "open_with", label: "Open With", icon: "dots", children: [{ id: "open_external", label: "Open External", icon: "external-link" }] },
    ]);
    const payload = lastPayload();
    expect(payload.items[0]).toEqual({
      id: "open_with",
      label: "Open With",
      iconSvg: iconToSvg("ellipsis", 16),
      children: [{ id: "open_external", label: "Open External", iconSvg: iconToSvg("externalLink", 16) }],
    });
    expect(payload.submenuIconSvg).toBe(iconToSvg("chevronRight", 16));
  });

  it("resolves every menu color to #rrggbb, flattening alpha over the overlay", async () => {
    await showContextMenu(0, 0, [{ id: "a", label: "A" }]);
    expect(lastPayload().colors).toEqual({
      overlay: "#202122",
      overlayBorder: "#2a2b2c",
      inkSecondary: "#bfbfbf",
      inkMuted: "#9d9d9d",
      selectionBg: "#1d3540",
      selectionBorder: "#0ea5e9",
      danger: "#f48771",
      dangerHover: "#352b2a",
      divider: "#2a2b2c",
    });
    for (const value of Object.values(lastPayload().colors)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("leaves out a color that does not resolve, so the main process uses its built-in value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubTokens(Object.fromEntries(Object.entries(TOKENS).filter(([token]) => token !== "--c-menu-danger-hover-bg")));
    await showContextMenu(0, 0, [{ id: "a", label: "A" }]);
    const colors = lastPayload().colors;
    expect(colors).not.toHaveProperty("dangerHover");
    expect(colors.inkSecondary).toBe("#bfbfbf");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("--c-menu-danger-hover-bg"), expect.any(Error));
  });

  it("sends an item without its icon when the icon cannot be rendered or is unknown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    icons.fail.add("pencil");
    await showContextMenu(0, 0, [
      { id: "edit", label: "Edit", icon: "edit" },
      { id: "odd", label: "Odd", icon: "unknown-key" as PopupMenuItem["icon"] },
    ]);
    expect(lastPayload().items).toEqual([
      { id: "edit", label: "Edit" },
      { id: "odd", label: "Odd" },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("sends the light theme and anchorRight", async () => {
    document.documentElement.classList.replace("dark", "light");
    await showContextMenu(5, 6, [{ id: "a", label: "A" }], { anchorRight: true });
    expect(lastPayload()).toMatchObject({ theme: "light", anchorRight: true });
  });

  it("returns the chosen id and brackets the call with popup-menu-change events", async () => {
    const events: boolean[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent<{ open: boolean }>).detail.open);
    document.addEventListener("conduit:popup-menu-change", listener);
    invoke.mockResolvedValue("delete");
    await expect(showContextMenu(0, 0, [{ id: "delete", label: "Delete" }])).resolves.toBe("delete");
    document.removeEventListener("conduit:popup-menu-change", listener);
    expect(events).toEqual([true, false]);
  });

  it("returns null and logs when the popup cannot be shown", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    invoke.mockRejectedValue(new Error("no window"));
    await expect(showContextMenu(0, 0, [{ id: "a", label: "A" }])).resolves.toBeNull();
    expect(error).toHaveBeenCalled();
  });
});
