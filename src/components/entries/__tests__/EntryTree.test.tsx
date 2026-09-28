import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import EntryTree from "../EntryTree";
import { useEntryStore } from "../../../stores/entryStore";
import { useSyncStore } from "../../../stores/syncStore";
import { useTeamStore } from "../../../stores/teamStore";
import { useTierStore } from "../../../stores/tierStore";
import { useVaultStore } from "../../../stores/vaultStore";
import type { EntryMeta, FolderData } from "../../../types/entry";

// Stores read settings through window.electron while these modules load.
vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

const showContextMenu = vi.fn();
vi.mock("../../../utils/contextMenu", () => ({
  showContextMenu: (...args: unknown[]) => showContextMenu(...args),
}));

const FOLDERS = [
  { id: "f1", name: "Production", parent_id: null, sort_order: 0 },
  { id: "f2", name: "Databases", parent_id: "f1", sort_order: 0 },
] as unknown as FolderData[];

const ENTRIES = [
  { id: "e1", name: "web-01", entry_type: "ssh", folder_id: "f1", sort_order: 1, is_favorite: true, host: "127.0.0.1" },
  { id: "e2", name: "db-01", entry_type: "ssh", folder_id: "f2", sort_order: 0, is_favorite: false },
  { id: "e3", name: "Runbook", entry_type: "document", folder_id: null, sort_order: 0, is_favorite: false },
  { id: "e4", name: "Locked Box", entry_type: "rdp", folder_id: null, sort_order: 1, is_favorite: false },
] as unknown as EntryMeta[];

function setup({ expanded = ["f1", "f2"], selected = [] as string[], locked = [] as string[] } = {}) {
  vi.stubGlobal("electron", {
    invoke: vi.fn(async (cmd: string, args?: { key?: string }) =>
      cmd === "ui_state_get" && args?.key?.startsWith("expanded-folders::") ? expanded : null,
    ),
    on: vi.fn(() => () => undefined),
  });
  useVaultStore.setState({ vaultType: "personal", currentVaultPath: "/v/Acme.conduit", teamVaultId: null } as never);
  useEntryStore.setState({
    entries: ENTRIES,
    folders: FOLDERS,
    selectedEntryIds: new Set(selected),
    updateEntry: vi.fn(async () => undefined),
    updateFolder: vi.fn(async () => undefined),
  } as never);
  useTierStore.setState({
    lockedEntryIds: new Set(locked),
    isEntryLocked: (id: string) => locked.includes(id),
    maxConnections: -1,
  } as never);
  useTeamStore.setState({ getEffectiveRole: () => null, canManagePermissions: () => false } as never);
  useSyncStore.setState({ conflictKeys: new Set<string>() } as never);
}

const rowOf = (name: string) => screen.getByText(name).closest("[style]") as HTMLElement;

beforeEach(() => {
  showContextMenu.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EntryTree rows", () => {
  it("draws 22px rows indented 8px per level from a 4px inset", async () => {
    setup();
    render(<EntryTree />);
    await screen.findByText("db-01");
    for (const [name, depth] of [["Production", 0], ["Databases", 1], ["db-01", 2], ["web-01", 1], ["Runbook", 0]] as const) {
      const row = rowOf(name);
      expect(row.className).toMatch(/\bh-row\b/);
      expect(row.className).toContain("gap-1.5");
      expect(row.className).toContain("text-body");
      expect(row.style.paddingLeft).toBe(`${4 + depth * 8}px`);
    }
  });

  it("gives folders a 16px twistie button and leaves a 16px spacer on leaf rows", async () => {
    setup();
    render(<EntryTree />);
    await screen.findByText("db-01");
    const twistie = rowOf("Production").querySelector("button") as HTMLButtonElement;
    expect(twistie.className).toContain("size-4");
    // The harness finds the twistie as the row's only unnamed button (restyle-data.mjs expandFolderInPage).
    expect(twistie.getAttribute("aria-label")).toBeNull();
    expect(twistie.title).toBe("");
    expect(twistie.querySelector("svg")?.getAttribute("width")).toBe("16");

    const leaf = rowOf("Runbook");
    expect(leaf.querySelector("button")).toBeNull();
    expect(leaf.querySelector(":scope > span.size-4")).not.toBeNull();
  });

  it("draws an indent guide per ancestor level at 12px + 8px steps, hidden until the tree is hovered", async () => {
    setup();
    const { container } = render(<EntryTree />);
    await screen.findByText("db-01");
    const guides = [...rowOf("db-01").querySelectorAll("[data-indent-guide]")] as HTMLElement[];
    expect(guides.map((g) => g.style.left)).toEqual(["12px", "20px"]);
    expect(guides[0].className).toContain("opacity-0");
    expect(guides[0].className).toContain("group-hover/tree:opacity-100");
    expect(guides[0].className).toContain("group-focus-within/tree:opacity-100");
    expect(rowOf("Runbook").querySelector("[data-indent-guide]")).toBeNull();
    expect((container.firstElementChild as HTMLElement).className).toContain("group/tree");
  });

  it("marks the selected row with data-selected and the neutral selection", async () => {
    setup({ selected: ["e3"] });
    render(<EntryTree />);
    await screen.findByText("db-01");
    const selected = rowOf("Runbook");
    expect(selected.hasAttribute("data-selected")).toBe(true);
    expect(selected.className).toContain("bg-selected");
    expect(selected.className).toContain("text-ink");
    expect(selected.className).not.toContain("conduit");
    const other = rowOf("db-01");
    expect(other.hasAttribute("data-selected")).toBe(false);
    expect(other.className).toContain("hover:bg-hover");
    expect(other.className).toContain("text-ink-secondary");
  });

  it("draws the favorite star and the lock at 12px", async () => {
    setup({ locked: ["e4"] });
    render(<EntryTree />);
    await screen.findByText("db-01");
    const star = rowOf("web-01").querySelector("svg.text-favorite") as SVGElement;
    expect(star.getAttribute("width")).toBe("12");
    const lockedRow = rowOf("Locked Box");
    expect(lockedRow.className).toContain("opacity-60");
    const lock = lockedRow.querySelector("svg.text-ink-faint") as SVGElement;
    expect(lock.getAttribute("width")).toBe("12");
  });

  it("renames in a 20px input that commits on Enter", async () => {
    setup();
    showContextMenu.mockResolvedValue("rename");
    render(<EntryTree />);
    await screen.findByText("db-01");
    await act(async () => {
      fireEvent.contextMenu(rowOf("Runbook"));
    });
    const input = (await screen.findByDisplayValue("Runbook")) as HTMLInputElement;
    expect(input.className).toContain("h-5");
    expect(input.className).toContain("text-body");
    expect(input.className).toContain("bg-input");
    expect(input.className).toContain("border-(--c-focus)");
    expect(input.className).toContain("flex-1");
    fireEvent.change(input, { target: { value: "Runbook 2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useEntryStore.getState().updateEntry).toHaveBeenCalledWith("e3", { name: "Runbook 2" });
  });
});

describe("EntryTree flat mode", () => {
  it("labels each group in title case without uppercase or letter spacing", async () => {
    setup();
    render(<EntryTree searchQuery="01" />);
    const label = await screen.findByText("Production / Databases");
    expect(label.className).not.toMatch(/\buppercase\b/);
    expect(label.className).not.toMatch(/\btracking-/);
    expect(label.className).toContain("text-meta");
    expect(label.className).toContain("font-semibold");
    expect(label.className).toContain("text-ink-muted");
    expect(label.title).toBe("Production / Databases");
    expect(screen.getByText("Production").title).toBe("Production");
  });

  it("keeps the empty texts", async () => {
    setup();
    render(<EntryTree searchQuery="zzz" />);
    await waitFor(() => expect(screen.getByText("No matching entries")).toBeTruthy());
    expect(screen.getByText("No matching entries").className).toContain("text-body");
  });
});
