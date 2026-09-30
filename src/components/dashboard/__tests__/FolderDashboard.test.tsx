import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import FolderDashboard from "../FolderDashboard";
import { useEntryStore } from "../../../stores/entryStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { useTierStore } from "../../../stores/tierStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { resetReachabilityCache } from "../reachability/useReachability";
import { toast } from "../../common/Toast";
import type { EntryMeta, FolderData } from "../../../types/entry";
import type { ReachabilityResult, RecentConnection } from "../../../types/dashboard";
import { entry, folder, minutesAgo, rowParts } from "./fixtures";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

const api = vi.hoisted(() => ({ checkReachability: vi.fn(), historyRecent: vi.fn() }));
vi.mock("../../../lib/dashboardApi", () => ({ dashboardApi: api }));

const openDashboardForEntry = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/openDashboard", () => ({ openDashboardForEntry, openFolderView: vi.fn() }));

const FOLDERS: FolderData[] = [folder({ id: "f1", name: "Production" }), folder({ id: "f2", name: "Databases", parent_id: "f1" })];
const ENTRIES: EntryMeta[] = [
  entry({ id: "a", name: "db-01", entry_type: "ssh", folder_id: "f2", host: "10.0.0.4" }),
  entry({ id: "b", name: "DC-01", entry_type: "rdp", folder_id: "f1", host: "10.0.0.5" }),
  entry({ id: "c", name: "Domain Admin", entry_type: "credential", folder_id: "f2" }),
  entry({ id: "d", name: "Runbook", entry_type: "document", folder_id: "f1" }),
];

const openEntry = vi.fn(async (_id: string) => undefined);

const reach = (entryId: string, status: ReachabilityResult["status"], port = 22): ReachabilityResult => ({
  entryId,
  status,
  host: "h",
  port,
  latencyMs: status === "reachable" ? 24 : null,
  checkedAt: new Date().toISOString(),
});

const recent = (entryId: string, minutes: number): RecentConnection => ({
  entryId,
  protocol: "ssh",
  lastStartedAt: minutesAgo(minutes),
  lastEndedAt: null,
  lastDurationMs: null,
  lastOutcome: "closed",
  count: 1,
});

async function setup({ entries = ENTRIES, locked = [] as string[] } = {}) {
  useEntryStore.setState({ entries, folders: FOLDERS, openEntry } as never);
  useTierStore.setState({ lockedEntryIds: new Set(locked) } as never);
  const view = render(<FolderDashboard folderId="f1" />);
  await act(async () => undefined);
  return view;
}

const list = () => document.querySelector("[data-cv-folder-list]") as HTMLElement;
const rowButtons = () => [...list().querySelectorAll<HTMLElement>("[data-cv-folder-row]")];
const rowLabels = () => rowButtons().map((b) => rowParts(b).label);
const rowFor = (name: string) => rowButtons().find((b) => rowParts(b).label === name)!.parentElement as HTMLElement;

beforeEach(() => {
  openEntry.mockReset().mockImplementation(async () => undefined);
  openDashboardForEntry.mockReset();
  api.checkReachability.mockReset();
  api.historyRecent.mockReset().mockResolvedValue([recent("b", 5)]);
  useSessionStore.setState({ sessions: [] } as never);
  useVaultStore.setState({ isUnlocked: true });
  resetReachabilityCache();
});

afterEach(() => vi.restoreAllMocks());

describe("FolderDashboard header", () => {
  it("caps the content at Home's width while the header divider spans the pane", async () => {
    const { container } = await setup();
    const header = container.querySelector(".border-b.border-divider") as HTMLElement;
    expect(header.className).not.toMatch(/max-w-4xl/);
    expect((header.firstElementChild as HTMLElement).className.split(" ")).toEqual(expect.arrayContaining(["mx-auto", "w-full", "max-w-4xl", "px-6"]));
    expect(header.className.split(" ")).not.toContain("p-6");
    const list = container.querySelector("[data-cv-folder-list]") as HTMLElement;
    expect(list.closest(".max-w-4xl")).not.toBeNull();
  });

  it("sits on the editor surface and keeps the header texts", async () => {
    const { container } = await setup();
    expect(container.firstElementChild).toHaveClass("bg-editor");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Production");
    expect(screen.getByText("4 entries · 1 sub-folder")).toBeInTheDocument();
    expect(container.querySelector(".bg-canvas, .bg-panel")).toBeNull();
  });

  it("keeps the type tiles in Home's order and drops the distribution bar, Recent Activity and Entry Age", async () => {
    const { container } = await setup();
    expect(screen.getByText("SSH").closest(".border-card-border")).not.toBeNull();
    const tiles = container.querySelector("[data-cv-type-tiles]") as HTMLElement;
    expect([...tiles.children].map((t) => t.querySelector(".text-meta")?.textContent)).toEqual(["SSH", "RDP", "Document", "Credential"]);
    for (const gone of ["Type Distribution", "Recent Activity", "Entry Age"]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it("offers Check all, Open all as the primary button, and New Entry for this folder", async () => {
    await setup();
    expect(screen.getByRole("button", { name: "Check all" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open all" })).toHaveClass("bg-btn-primary");
    const onNew = vi.fn();
    document.addEventListener("conduit:new-entry", onNew, { once: true });
    fireEvent.click(screen.getByRole("button", { name: "New Entry" }));
    expect((onNew.mock.calls[0][0] as CustomEvent).detail).toEqual({ folderId: "f1" });
  });
});

describe("FolderDashboard list", () => {
  it("lists every entry below the folder by name with host, sub-folder path and last connected", async () => {
    await setup();
    expect(api.historyRecent).toHaveBeenCalledWith({ limit: 50 });
    expect(rowLabels()).toEqual(["db-01", "DC-01", "Domain Admin", "Runbook"]);
    expect(within(rowFor("db-01")).getByText("10.0.0.4 · in Databases")).toBeInTheDocument();
    expect(within(rowFor("Domain Admin")).getByText("in Databases")).toBeInTheDocument();
    expect(within(rowFor("DC-01")).getByText("5m ago")).toBeInTheDocument();
  });

  it("filters by the search and says when nothing matches", async () => {
    await setup();
    fireEvent.change(screen.getByPlaceholderText("Search this folder..."), { target: { value: "10.0.0.5" } });
    expect(rowLabels()).toEqual(["DC-01"]);
    fireEvent.change(screen.getByPlaceholderText("Search this folder..."), { target: { value: "zzz" } });
    expect(screen.getByText("No entries match your search")).toHaveClass("text-label", "text-ink-faint", "text-center");
  });

  it("sorts by the chosen order", async () => {
    await setup();
    const select = screen.getByLabelText("Sort by") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["Name", "Type", "Last connected", "Status"]);
    fireEvent.change(select, { target: { value: "type" } });
    expect(rowLabels()).toEqual(["Domain Admin", "Runbook", "DC-01", "db-01"]);
    fireEvent.change(select, { target: { value: "last-connected" } });
    expect(rowLabels()[0]).toBe("DC-01");
  });

  it("opens a row, and opens a credential's info instead", async () => {
    await setup();
    fireEvent.click(rowButtons()[0]);
    expect(openEntry).toHaveBeenCalledWith("a");
    fireEvent.click(rowButtons()[2]);
    expect(openDashboardForEntry).toHaveBeenCalledWith("c");
    expect(openEntry).toHaveBeenCalledTimes(1);
  });

  it("gives rows Check if it is up (with a host only), Open (not for credentials) and View info", async () => {
    await setup();
    const titles = (name: string) => [...rowFor(name).querySelectorAll(":scope > span button")].map((b) => b.getAttribute("title"));
    expect(titles("db-01")).toEqual(["Check if it is up", "Open", "View info"]);
    expect(titles("Domain Admin")).toEqual(["View info"]);
    expect(titles("Runbook")).toEqual(["Open", "View info"]);
    fireEvent.click(within(rowFor("Runbook")).getByTitle("View info"));
    expect(openDashboardForEntry).toHaveBeenCalledWith("d");
    fireEvent.click(within(rowFor("DC-01")).getByTitle("Open"));
    expect(openEntry).toHaveBeenCalledWith("b");
  });

  it("checks one row, disables its button while it runs and shows the badge", async () => {
    let resolve!: (r: ReachabilityResult) => void;
    api.checkReachability.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await setup();
    const button = within(rowFor("DC-01")).getByTitle("Check if it is up");
    fireEvent.click(button);
    expect(api.checkReachability).toHaveBeenCalledWith({ entryId: "b" });
    expect(button).toBeDisabled();
    await act(async () => resolve(reach("b", "refused", 3389)));
    expect(button).toBeEnabled();
    const badge = within(rowFor("DC-01")).getByText("Port closed");
    expect(badge).toHaveClass("text-warning");
    expect(badge).toHaveAttribute("title", "Nothing is listening on port 3389");
  });
});

describe("FolderDashboard Open all", () => {
  it("opens connection entries one after another and skips documents, credentials and locked entries", async () => {
    await setup({ locked: ["a"] });
    fireEvent.click(screen.getByRole("button", { name: "Open all" }));
    await act(async () => undefined);
    expect(openEntry.mock.calls).toEqual([["b"]]);
  });

  it("stops before the next entry when the view closes or the vault locks", async () => {
    const pending: Array<() => void> = [];
    openEntry.mockImplementation(() => new Promise<undefined>((resolve) => pending.push(() => resolve(undefined))));
    const both = [...ENTRIES, entry({ id: "e", name: "web-02", entry_type: "web", folder_id: "f1", host: "intra" })];

    const view = await setup({ entries: both });
    fireEvent.click(screen.getByRole("button", { name: "Open all" }));
    await act(async () => undefined);
    expect(openEntry).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => pending.shift()!());
    expect(openEntry).toHaveBeenCalledTimes(1);

    openEntry.mockClear();
    await setup({ entries: both });
    fireEvent.click(screen.getByRole("button", { name: "Open all" }));
    await act(async () => undefined);
    expect(openEntry).toHaveBeenCalledTimes(1);
    act(() => useVaultStore.setState({ isUnlocked: false }));
    await act(async () => pending.shift()!());
    expect(openEntry).toHaveBeenCalledTimes(1);
  });

  it("asks first above five and opens the listed ones on confirm", async () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      entry({ id: `s${i}`, name: `srv-${i}`, entry_type: "ssh", folder_id: "f1", host: `10.0.1.${i}` }),
    );
    await setup({ entries: [...many, ENTRIES[3]] });
    fireEvent.click(screen.getByRole("button", { name: "Open all" }));
    expect(openEntry).not.toHaveBeenCalled();
    expect(screen.getByText("Open 6 connections?")).toBeInTheDocument();
    expect(screen.getByText("This opens 6 sessions at once. Commands and documents are not opened.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open 6" }));
    await act(async () => undefined);
    expect(openEntry.mock.calls.map((c) => c[0])).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
  });

  it("does not ask for exactly five, and Cancel opens nothing above five", async () => {
    const five = Array.from({ length: 5 }, (_, i) => entry({ id: `s${i}`, name: `srv-${i}`, entry_type: "vnc", folder_id: "f1" }));
    const { unmount } = await setup({ entries: five });
    fireEvent.click(screen.getByRole("button", { name: "Open all" }));
    await act(async () => undefined);
    expect(openEntry).toHaveBeenCalledTimes(5);
    unmount();

    openEntry.mockClear();
    await setup({ entries: [...five, entry({ id: "s5", name: "srv-5", entry_type: "web", folder_id: "f1" })] });
    fireEvent.click(screen.getByRole("button", { name: "Open all" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Open 6 connections?")).toBeNull();
    expect(openEntry).not.toHaveBeenCalled();
  });

  it("is disabled with a reason when nothing can open", async () => {
    await setup({ entries: [ENTRIES[2], ENTRIES[3]] });
    const button = screen.getByRole("button", { name: "Open all" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Nothing to open here");
  });
});

describe("FolderDashboard Check all", () => {
  it("checks the listed entries in order, four at a time, with the progress label", async () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      entry({ id: `s${i}`, name: `srv-${i}`, entry_type: "ssh", folder_id: "f1", host: `10.0.1.${i}` }),
    );
    const pending: { id: string; resolve: (r: ReachabilityResult) => void }[] = [];
    api.checkReachability.mockImplementation(({ entryId }: { entryId: string }) =>
      new Promise((resolve) => pending.push({ id: entryId, resolve })),
    );
    await setup({ entries: [...many, ENTRIES[3]] });
    fireEvent.click(screen.getByRole("button", { name: "Check all" }));
    await act(async () => undefined);
    expect(pending.map((p) => p.id)).toEqual(["s0", "s1", "s2", "s3"]);
    const busy = screen.getByRole("button", { name: "Checking 0 of 6..." });
    expect(busy).toBeDisabled();

    await act(async () => pending[0].resolve(reach("s0", "reachable")));
    expect(screen.getByRole("button", { name: "Checking 1 of 6..." })).toBeInTheDocument();
    expect(pending.map((p) => p.id)).toEqual(["s0", "s1", "s2", "s3", "s4"]);

    await act(async () => {
      for (let i = 1; i < 6; i++) {
        await Promise.resolve();
        pending[i]?.resolve(reach(pending[i].id, "timeout"));
      }
    });
    await act(async () => {
      pending[5]?.resolve(reach("s5", "timeout"));
    });
    expect(screen.getByRole("button", { name: "Check all" })).toBeEnabled();
    expect(within(rowFor("srv-0")).getByText("Up")).toHaveClass("text-success");
    expect(within(rowFor("srv-5")).getByText("No answer")).toBeInTheDocument();
  });

  it("checks at most 50 and says so", async () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "t");
    const many = Array.from({ length: 52 }, (_, i) =>
      entry({ id: `s${String(i).padStart(2, "0")}`, name: `srv-${String(i).padStart(2, "0")}`, entry_type: "rdp", folder_id: "f1", host: "h" }),
    );
    api.checkReachability.mockImplementation(async ({ entryId }: { entryId: string }) => reach(entryId, "reachable"));
    await setup({ entries: many });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check all" }));
    });
    await act(async () => undefined);
    expect(api.checkReachability).toHaveBeenCalledTimes(50);
    expect(api.checkReachability.mock.calls.map((c) => c[0].entryId)).not.toContain("s50");
    expect(info).toHaveBeenCalledWith("Checked the first 50 entries", "Search or sort the list to check others.");
  });
});

describe("FolderDashboard empty", () => {
  it("keeps the empty state and its New Entry primary button", async () => {
    await setup({ entries: [] });
    expect(screen.getByText("This folder is empty")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "New Entry" });
    const primary = buttons.find((b) => b.className.includes("bg-btn-primary"))!;
    const onNew = vi.fn();
    document.addEventListener("conduit:new-entry", onNew, { once: true });
    fireEvent.click(primary);
    expect(onNew).toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("Search this folder...")).toBeNull();
  });
});
