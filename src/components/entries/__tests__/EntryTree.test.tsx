import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import EntryTree from "../EntryTree";
import { useEntryStore } from "../../../stores/entryStore";
import { useSessionStore } from "../../../stores/sessionStore";
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

const openers = vi.hoisted(() => ({ openFolderView: vi.fn(), openDashboardForEntry: vi.fn() }));
vi.mock("../../../lib/openDashboard", () => openers);

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

function setup({
  expanded = ["f1", "f2"],
  selected = [] as string[],
  locked = [] as string[],
  vaultType = "personal",
  role = null as string | null,
  canManagePermissions = false,
} = {}) {
  vi.stubGlobal("electron", {
    invoke: vi.fn(async (cmd: string, args?: { key?: string }) =>
      cmd === "ui_state_get" && args?.key?.startsWith("expanded-folders::") ? expanded : null,
    ),
    on: vi.fn(() => () => undefined),
  });
  useVaultStore.setState({ vaultType, currentVaultPath: "/v/Acme.conduit", teamVaultId: vaultType === "team" ? "t1" : null } as never);
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
  useTeamStore.setState({ getEffectiveRole: () => role, canManagePermissions: () => canManagePermissions } as never);
  useSyncStore.setState({ conflictKeys: new Set<string>() } as never);
}

const rowOf = (name: string) => screen.getByText(name).closest("[style]") as HTMLElement;

beforeEach(() => {
  showContextMenu.mockReset();
  openers.openFolderView.mockReset();
  openers.openDashboardForEntry.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EntryTree rows", () => {
  it("draws 22px rows indented 12px per level from a 4px inset", async () => {
    setup();
    render(<EntryTree />);
    await screen.findByText("db-01");
    for (const [name, depth] of [["Production", 0], ["Databases", 1], ["db-01", 2], ["web-01", 1], ["Runbook", 0]] as const) {
      const row = rowOf(name);
      expect(row.className).toMatch(/\bh-row\b/);
      expect(row.className).toContain("gap-1.5");
      expect(row.className).toContain("text-body");
      expect(row.style.paddingLeft).toBe(`${4 + depth * 12}px`);
    }
  });

  it("gives folders a named 16px twistie button with the harness hook and leaves a 16px spacer on leaf rows", async () => {
    setup({ expanded: ["f1"] });
    render(<EntryTree />);
    await screen.findByText("Databases");
    const twistie = rowOf("Production").querySelector("button") as HTMLButtonElement;
    expect(twistie.className).toContain("size-4");
    expect(twistie.hasAttribute("data-cv-tree-twistie")).toBe(true);
    expect(twistie.getAttribute("aria-label")).toBe("Collapse");
    expect(twistie.title).toBe("Collapse");
    expect(twistie.querySelector("svg")?.getAttribute("width")).toBe("16");
    const closed = rowOf("Databases").querySelector("button") as HTMLButtonElement;
    expect(closed.getAttribute("aria-label")).toBe("Expand");
    expect(closed.title).toBe("Expand");

    const leaf = rowOf("Runbook");
    expect(leaf.querySelector("button")).toBeNull();
    expect(leaf.querySelector(":scope > span.size-4")).not.toBeNull();
  });

  it("draws an indent guide per ancestor level at 12px + 12px steps, hidden until the tree is hovered", async () => {
    setup();
    const { container } = render(<EntryTree />);
    await screen.findByText("db-01");
    const guides = [...rowOf("db-01").querySelectorAll("[data-indent-guide]")] as HTMLElement[];
    expect(guides.map((g) => g.style.left)).toEqual(["12px", "24px"]);
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
    const label = (await screen.findByText("Production / Databases")).parentElement as HTMLElement;
    expect(label.className).toMatch(/\bh-row\b/);
    expect(label.className).not.toMatch(/\bpt-2\b/);
    expect(label.parentElement?.className).toContain("mt-2");
    expect(label.className).not.toMatch(/\buppercase\b/);
    expect(label.className).not.toMatch(/\btracking-/);
    expect(label.className).toContain("text-meta");
    expect(label.className).toContain("font-semibold");
    expect(label.className).toContain("text-ink-muted");
    expect(label.title).toBe("Production / Databases");
    expect(screen.getByText("Production").parentElement?.title).toBe("Production");
  });

  it("keeps the empty texts", async () => {
    setup();
    render(<EntryTree searchQuery="zzz" />);
    await waitFor(() => expect(screen.getByText("No matching entries")).toBeTruthy());
    expect(screen.getByText("No matching entries").className).toContain("text-body");
  });
});

type MenuItem = { id: string; label: string; icon?: string; type?: string };

async function menuFor(name: string, choose: string | null = null): Promise<MenuItem[]> {
  showContextMenu.mockResolvedValue(choose);
  await act(async () => {
    fireEvent.contextMenu(rowOf(name));
  });
  await waitFor(() => expect(showContextMenu).toHaveBeenCalled());
  const calls = showContextMenu.mock.calls;
  return calls[calls.length - 1][2] as MenuItem[];
}

describe("EntryTree View Info", () => {
  it("puts View Info first in a folder menu, then a separator, and opens the folder view", async () => {
    setup();
    render(<EntryTree />);
    await screen.findByText("db-01");
    const items = await menuFor("Production", "view_info");
    expect(items[0]).toMatchObject({ id: "view_info", label: "View Info", icon: "infoCircle" });
    expect(items[1].type).toBe("separator");
    expect(items[2].id).toBe("new_entry");
    await waitFor(() => expect(openers.openFolderView).toHaveBeenCalledWith("f1"));
    expect(openers.openDashboardForEntry).not.toHaveBeenCalled();
  });

  it("gives a team viewer View Info alone, and no doubled separator before Manage Permissions", async () => {
    setup({ vaultType: "team", role: "viewer" });
    const { unmount } = render(<EntryTree />);
    await screen.findByText("db-01");
    expect((await menuFor("Production")).map((i) => i.id)).toEqual(["view_info"]);
    unmount();

    showContextMenu.mockReset();
    setup({ vaultType: "team", role: "viewer", canManagePermissions: true });
    render(<EntryTree />);
    await screen.findByText("db-01");
    expect((await menuFor("Production")).map((i) => i.id)).toEqual(["view_info", "sep_perms", "manage_permissions"]);
  });

  it("uses the info icon for an entry's View Info and opens its info tab", async () => {
    setup();
    render(<EntryTree />);
    await screen.findByText("db-01");
    const items = await menuFor("web-01", "view_info");
    expect(items.find((i) => i.id === "view_info")).toMatchObject({ label: "View Info", icon: "infoCircle" });
    await waitFor(() => expect(openers.openDashboardForEntry).toHaveBeenCalledWith("e1"));
    expect(openers.openFolderView).not.toHaveBeenCalled();
  });
});

describe("EntryTree double-click", () => {
  const CRED = { id: "c1", name: "Domain Admin", entry_type: "credential", credential_type: null, folder_id: null, sort_order: 5, is_favorite: false } as unknown as EntryMeta;
  const GW = { id: "g1", name: "Office", entry_type: "credential", credential_type: "rd_gateway", folder_id: null, sort_order: 6, is_favorite: false } as unknown as EntryMeta;
  const openOrFocusEntry = vi.fn(async () => undefined);
  const openEntry = vi.fn(async () => undefined);
  const edits: unknown[] = [];
  const onEdit = (e: Event) => edits.push((e as CustomEvent).detail);

  beforeEach(() => {
    openOrFocusEntry.mockClear();
    openEntry.mockClear();
    edits.length = 0;
    document.addEventListener("conduit:edit-entry", onEdit);
    useSessionStore.setState({ sessions: [] } as never);
  });
  afterEach(() => document.removeEventListener("conduit:edit-entry", onEdit));

  function withEntries(opts: Parameters<typeof setup>[0] = {}) {
    setup(opts);
    useEntryStore.setState({ entries: [...ENTRIES, CRED, GW], openOrFocusEntry, openEntry } as never);
  }

  it.each([["Domain Admin", "c1"], ["Office", "g1"]])("opens the edit dialog for %s", async (name, id) => {
    withEntries();
    render(<EntryTree />);
    fireEvent.doubleClick(rowOf(await screen.findByText(name).then((el) => el.textContent!)));
    expect(edits).toEqual([id]);
    expect(openOrFocusEntry).not.toHaveBeenCalled();
  });

  it("shows a credential's info instead when the vault is view-only", async () => {
    withEntries({ vaultType: "team", role: "viewer" });
    render(<EntryTree />);
    fireEvent.doubleClick(rowOf(await screen.findByText("Domain Admin").then((el) => el.textContent!)));
    expect(edits).toEqual([]);
    expect(openers.openDashboardForEntry).toHaveBeenCalledWith("c1");
  });

  it("does not edit or show a credential the plan locks", async () => {
    withEntries({ locked: ["c1"] });
    render(<EntryTree />);
    fireEvent.doubleClick(rowOf(await screen.findByText("Domain Admin").then((el) => el.textContent!)));
    expect(edits).toEqual([]);
    expect(openers.openDashboardForEntry).not.toHaveBeenCalledWith("c1");
  });

  it("connects a connection entry, or switches to its open tab", async () => {
    withEntries();
    render(<EntryTree />);
    fireEvent.doubleClick(rowOf(await screen.findByText("Locked Box").then((el) => el.textContent!)));
    expect(openOrFocusEntry).toHaveBeenCalledWith("e4");
    expect(openEntry).not.toHaveBeenCalled();
    expect(edits).toEqual([]);
  });

  it("leaves folders to their single-click expand", async () => {
    withEntries();
    render(<EntryTree />);
    fireEvent.doubleClick(rowOf(await screen.findByText("Production").then((el) => el.textContent!)));
    expect(edits).toEqual([]);
    expect(openOrFocusEntry).not.toHaveBeenCalled();
  });
});

describe("EntryTree open items with a session open", () => {
  const openOrFocusEntry = vi.fn(async () => undefined);
  const openEntry = vi.fn(async () => undefined);

  beforeEach(() => {
    openOrFocusEntry.mockClear();
    openEntry.mockClear();
  });

  function withSession(entryId: string, type: "ssh" | "rdp") {
    setup();
    useEntryStore.setState({ openOrFocusEntry, openEntry } as never);
    useSessionStore.setState({ sessions: [{ id: `s-${entryId}`, type, title: "x", status: "connected", entryId }] } as never);
  }

  it("offers Go to Session and Open New Session on an SSH entry with a tab open", async () => {
    withSession("e1", "ssh");
    render(<EntryTree />);
    await screen.findByText("web-01");
    const items = await menuFor("web-01", "open_new");
    expect(items.slice(0, 2).map((i) => [i.id, i.label])).toEqual([["open", "Go to Session"], ["open_new", "Open New Session"]]);
    await waitFor(() => expect(openEntry).toHaveBeenCalledWith("e1"));
  });

  it("switches to the open tab from Go to Session", async () => {
    withSession("e1", "ssh");
    render(<EntryTree />);
    await screen.findByText("web-01");
    await menuFor("web-01", "open");
    await waitFor(() => expect(openOrFocusEntry).toHaveBeenCalledWith("e1"));
    expect(openEntry).not.toHaveBeenCalled();
  });

  it("offers no second session on RDP, which would drop the first", async () => {
    withSession("e4", "rdp");
    render(<EntryTree />);
    const items = await menuFor(await screen.findByText("Locked Box").then((el) => el.textContent!));
    expect(items[0]).toMatchObject({ id: "open", label: "Go to Session" });
    expect(items.some((i) => i.id === "open_new")).toBe(false);
  });

  it("keeps Open Session when nothing is open", async () => {
    setup();
    useSessionStore.setState({ sessions: [] } as never);
    render(<EntryTree />);
    await screen.findByText("web-01");
    const items = await menuFor("web-01");
    expect(items[0]).toMatchObject({ id: "open", label: "Open Session" });
    expect(items.some((i) => i.id === "open_new")).toBe(false);
  });
});

describe("EntryTree RD Gateway objects", () => {
  const GATEWAY = {
    id: "g1", name: "Office gateway", entry_type: "credential", credential_type: "rd_gateway",
    folder_id: null, sort_order: 2, is_favorite: false, config: { gatewayHostname: "gw" },
  } as unknown as EntryMeta;

  function withGateway(rdpConfigs: Record<string, unknown>[]) {
    const rdp = rdpConfigs.map((config, i) => ({
      id: `r${i}`, name: `app-0${i}`, entry_type: "rdp", folder_id: null, sort_order: 3 + i, is_favorite: false, config,
    })) as unknown as EntryMeta[];
    useEntryStore.setState({ entries: [...ENTRIES, GATEWAY, ...rdp], selectedEntryIds: new Set(["g1"]), selectedEntryId: "g1" } as never);
  }

  it("shows a gateway in the tree with the gateway color, not the credential color", async () => {
    setup();
    withGateway([]);
    render(<EntryTree />);
    const row = rowOf(await screen.findByText("Office gateway").then((el) => el.textContent!));
    expect(row.querySelector(".text-entry-rdp")).not.toBeNull();
    expect(row.querySelector(".text-entry-credential")).toBeNull();
  });

  it("says how many RDP entries use a gateway before deleting it", async () => {
    setup();
    withGateway([{ gatewayId: "g1" }, { gatewayId: "g1" }, {}]);
    render(<EntryTree />);
    await screen.findByText("Office gateway");
    act(() => {
      document.dispatchEvent(new CustomEvent("conduit:delete-selected"));
    });
    expect(
      await screen.findByText('Delete the gateway "Office gateway"? 2 RDP entries use it. They will not connect until you pick another gateway for them.'),
    ).toBeTruthy();
  });
});

type MenuTree = MenuItem & { children?: MenuItem[] };

function recordCreateEvents() {
  const events: Array<{ type: string; detail: unknown }> = [];
  const record = (e: Event) => events.push({ type: e.type, detail: (e as CustomEvent).detail });
  document.addEventListener("conduit:new-entry", record);
  document.addEventListener("conduit:new-folder", record);
  return {
    events,
    stop: () => {
      document.removeEventListener("conduit:new-entry", record);
      document.removeEventListener("conduit:new-folder", record);
    },
  };
}

describe("EntryTree create items", () => {
  it("gives a folder a typed New Entry submenu, then New Folder and Add Knowledge Article", async () => {
    setup();
    render(<EntryTree />);
    await screen.findByText("db-01");
    const items = (await menuFor("Production")) as MenuTree[];
    expect(items.slice(2, 5).map((i) => i.id)).toEqual(["new_entry", "new_folder", "new_article"]);
    const children = items[2].children!.filter((c) => !c.type).map((c) => c.label);
    expect(children).toEqual(["SSH", "RDP", "VNC", "Web", "RD Gateway", "Document", "Command", "Password", "SSH Key"]);
  });

  it("creates a typed entry or a subfolder inside the right-clicked folder", async () => {
    setup();
    const { events, stop } = recordCreateEvents();
    render(<EntryTree />);
    await screen.findByText("db-01");
    await menuFor("Databases", "new_entry:rdp");
    await menuFor("Databases", "new_entry:credential:ssh_key");
    await menuFor("Databases", "new_folder");
    await waitFor(() => expect(events).toHaveLength(3));
    stop();
    expect(events).toEqual([
      { type: "conduit:new-entry", detail: { folderId: "f2", type: "rdp" } },
      { type: "conduit:new-entry", detail: { folderId: "f2", type: "credential", credentialType: "ssh_key" } },
      { type: "conduit:new-folder", detail: { parentId: "f2" } },
    ]);
  });

  it("offers New in This Folder on an entry and creates beside it", async () => {
    setup();
    const { events, stop } = recordCreateEvents();
    render(<EntryTree />);
    await screen.findByText("db-01");
    const items = (await menuFor("web-01", "new_entry:ssh")) as MenuTree[];
    const here = items.find((i) => i.id === "new_here")!;
    expect(here.label).toBe("New in This Folder");
    expect(here.children!.map((c) => c.id)).toContain("new_folder");
    await menuFor("web-01", "new_folder");
    await waitFor(() => expect(events).toHaveLength(2));
    stop();
    expect(events).toEqual([
      { type: "conduit:new-entry", detail: { folderId: "f1", type: "ssh" } },
      { type: "conduit:new-folder", detail: { parentId: "f1" } },
    ]);
  });

  it("names the entry submenu for the top level when the entry has no folder", async () => {
    setup();
    const { events, stop } = recordCreateEvents();
    render(<EntryTree />);
    await screen.findByText("db-01");
    const items = (await menuFor("Runbook", "new_entry:web")) as MenuTree[];
    expect(items.find((i) => i.id === "new_here")?.label).toBe("New at Top Level");
    await waitFor(() => expect(events).toHaveLength(1));
    stop();
    expect(events[0]).toEqual({ type: "conduit:new-entry", detail: { folderId: null, type: "web" } });
  });

  it("leaves create items off an entry for a team viewer and off a locked entry", async () => {
    setup({ vaultType: "team", role: "viewer" });
    const { unmount } = render(<EntryTree />);
    await screen.findByText("db-01");
    expect((await menuFor("web-01")).map((i) => i.id)).not.toContain("new_here");
    unmount();

    showContextMenu.mockReset();
    setup({ locked: ["e4"] });
    render(<EntryTree />);
    await screen.findByText("db-01");
    expect((await menuFor("Locked Box")).map((i) => i.id)).not.toContain("new_here");
  });

  it("tells an empty vault where to create", async () => {
    setup();
    useEntryStore.setState({ entries: [], folders: [] } as never);
    const { unmount } = render(<EntryTree />);
    expect(await screen.findByText("No entries yet. Right-click here or use + above to add one.")).toBeTruthy();
    unmount();

    setup({ vaultType: "team", role: "editor" });
    useEntryStore.setState({ entries: [], folders: [] } as never);
    render(<EntryTree />);
    expect(await screen.findByText("Right-click here or use + above to add your first connection or credential.")).toBeTruthy();
  });
});
