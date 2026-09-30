import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import DashboardOverview from "../DashboardOverview";
import { resetHomeSettings } from "../home/useHomeSettings";
import { resetHomeFeeds } from "../home/homeFeeds";
import { HOME_SECTION_IDS } from "../../../types/dashboard";
import { dashboardApi } from "../../../lib/dashboardApi";
import { useAuthStore } from "../../../stores/authStore";
import { useEntryStore } from "../../../stores/entryStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { useSyncStore } from "../../../stores/syncStore";
import { useTeamStore } from "../../../stores/teamStore";
import { useTierStore } from "../../../stores/tierStore";
import { useVaultStore } from "../../../stores/vaultStore";
import type { HomeSectionId } from "../../../types/dashboard";
import { entry, folder, minutesAgo, rowParts } from "./fixtures";

// Stores read settings through window.electron while these modules load.
const invoke = vi.hoisted(() => {
  const fn = vi.fn(async (_channel: string, _args?: unknown): Promise<unknown> => null);
  Object.assign(globalThis, { electron: { invoke: fn, on: () => () => undefined } });
  return fn;
});
vi.mock("../../../lib/dashboardApi", () => ({
  dashboardApi: {
    historyRecent: vi.fn(),
    historyClear: vi.fn(),
    passwordAges: vi.fn(),
    aiActivity: vi.fn(),
  },
}));

const api = vi.mocked(dashboardApi);

const ENTRIES = [
  entry({ id: "w", name: "Intranet Status", entry_type: "web", is_favorite: true, tags: ["prod"] }),
  entry({ id: "s", name: "web-01", entry_type: "ssh", is_favorite: true }),
  entry({ id: "k", name: "deploy-job", entry_type: "command" }),
  entry({ id: "d", name: "Runbook", entry_type: "document" }),
  entry({ id: "c", name: "Domain Admin", entry_type: "credential" }),
];

const setSelectedEntry = vi.fn();
const openEntry = vi.fn();

interface Setup {
  hidden?: HomeSectionId[];
  entries?: typeof ENTRIES;
  folders?: ReturnType<typeof folder>[];
  maxConnections?: number;
  trialDays?: number;
}

async function setup(opts: Setup & { active?: boolean } = {}) {
  invoke.mockImplementation(async (channel: string) => (channel === "ui_state_get" ? { hidden: opts.hidden ?? [] } : null));
  useEntryStore.setState({
    entries: opts.entries ?? ENTRIES,
    folders: opts.folders ?? [folder({ id: "f1", name: "Production" }), folder({ id: "f2", name: "Staging" })],
    setSelectedEntry,
    openEntry,
  } as never);
  useSessionStore.setState({
    sessions: [
      { id: "__home__", type: "dashboard", title: "Home", status: "connected" },
      { id: "t1", type: "local_shell", title: "Terminal", status: "connected" },
    ],
  });
  useVaultStore.setState({
    vaultType: "personal",
    cloudSyncState: null,
    localBackupState: { status: "idle", lastBackedUpAt: null, error: null, enabled: false, backupPath: null, retentionDays: 7 },
    credentials: [{ id: "c" }],
    teamSyncState: null,
  } as never);
  useTeamStore.setState({ canCreate: () => true } as never);
  useTierStore.setState({
    maxConnections: opts.maxConnections ?? -1,
    isTrialing: opts.trialDays !== undefined,
    trialDaysRemaining: opts.trialDays ?? 0,
    lockedEntryIds: new Set<string>(),
  } as never);
  useAuthStore.setState({ authMode: "local", profile: { display_name: "Chris Smith" } } as never);
  useSyncStore.setState({ state: null, displaced: null, sessionConflict: null } as never);
  const view = render(<DashboardOverview active={opts.active ?? true} />);
  await act(async () => undefined);
  return view;
}

const cardTitles = () => screen.queryAllByRole("heading", { level: 3 }).map((h) => h.textContent);
const card = (title: string) => screen.getByRole("heading", { level: 3, name: title }).closest(".border-card-border") as HTMLElement;

beforeEach(() => {
  resetHomeSettings();
  resetHomeFeeds();
  setSelectedEntry.mockReset();
  openEntry.mockReset();
  api.historyRecent.mockResolvedValue([
    { entryId: "s", protocol: "ssh", lastStartedAt: minutesAgo(5), lastEndedAt: null, lastDurationMs: null, lastOutcome: "closed", count: 3 },
  ]);
  api.passwordAges.mockResolvedValue([{ entryId: "c", setAt: minutesAgo(60 * 24 * 400), source: "created" }]);
  api.aiActivity.mockResolvedValue({ items: [{ at: minutesAgo(2), tool: "terminal_execute", outcome: "success", durationMs: 5, entryId: "s", sessionId: null }], logFound: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetHomeSettings();
});

describe("DashboardOverview (Home)", () => {
  it("sits on the editor surface in the page column", async () => {
    const { container } = await setup();
    expect(container.firstElementChild).toHaveClass("bg-editor", "@container");
    expect(container.querySelector(".max-w-4xl.mx-auto.p-6.space-y-6")).not.toBeNull();
    expect(container.querySelector(".grid.grid-cols-1.\\@2xl\\:grid-cols-2.gap-4")).not.toBeNull();
  });

  it("keeps each card at its own height in the grid", async () => {
    const { container } = await setup();
    expect(container.querySelector(".grid.grid-cols-1")).toHaveClass("items-start");
  });

  it("says so when every section is hidden", async () => {
    await setup({ hidden: [...HOME_SECTION_IDS] });
    await screen.findByText("All sections are hidden. Use Customize to show them.");
    expect(screen.getByText("All sections are hidden. Use Customize to show them.")).toHaveClass("text-label", "text-ink-faint");
    expect(cardTitles()).toEqual([]);
    expect(screen.getByRole("button", { name: "Customize" })).toBeInTheDocument();
  });

  it("does not poll AI activity or load history while the Home tab is behind another tab", async () => {
    api.aiActivity.mockClear();
    api.historyRecent.mockClear();
    await setup({ active: false });
    await act(async () => undefined);
    expect(api.aiActivity).not.toHaveBeenCalled();
    expect(api.historyRecent).not.toHaveBeenCalled();
  });

  it("keeps the welcome heading with the first name and the counts line, with Customize on the right", async () => {
    await setup();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Welcome back, Chris");
    expect(screen.getByText("5 entries · 1 credential · 2 folders")).toHaveClass("text-body", "text-ink-muted");
    const customize = screen.getByRole("button", { name: "Customize" });
    expect(customize).toHaveClass("h-control-sm");
  });

  it("shows every section in order when each has something to show", async () => {
    await setup({ maxConnections: 3 });
    await screen.findByText("Recently connected");
    await screen.findByText("AI activity");
    expect(screen.getByRole("combobox")).toHaveAttribute("placeholder", "Search entries and folders...");
    expect(cardTitles()).toEqual(["Recently connected", "Open now", "Favorites", "Needs attention", "AI activity", "Vault status", "Overview"]);
    for (const title of cardTitles()) expect(card(title as string)).toHaveClass("rounded-md", "border-card-border", "bg-well");
    expect(card("AI activity")).toHaveClass("@2xl:col-span-2");
  });

  it("hides sections that are turned off", async () => {
    await setup({ hidden: ["quick", "favorites", "vault-status"] });
    await screen.findByText("Recently connected");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Quick Connect/ })).toBeNull();
    await waitFor(() => expect(cardTitles()).toEqual(["Recently connected", "Open now", "Needs attention", "AI activity"]));
  });

  it("hides sections that have nothing to show", async () => {
    api.historyRecent.mockResolvedValue([]);
    api.passwordAges.mockResolvedValue([]);
    api.aiActivity.mockResolvedValue({ items: [], logFound: false });
    await setup({ entries: ENTRIES.map((e) => ({ ...e, is_favorite: false })) });
    act(() => useSessionStore.setState({ sessions: [] }));
    await act(async () => undefined);
    expect(cardTitles()).toEqual(["Vault status", "Overview"]);
  });

  it("draws favorites with the type label, opens on a single click and offers the row actions", async () => {
    await setup();
    const favorites = card("Favorites");
    const rows = within(favorites).getAllByRole("button").filter((b) => !b.hasAttribute("aria-label"));
    expect(rows.map(rowParts)).toEqual([
      { label: "Intranet Status", meta: "Web" },
      { label: "web-01", meta: "SSH" },
    ]);
    fireEvent.click(rows[1]);
    expect(openEntry).toHaveBeenCalledWith("s");
    expect(setSelectedEntry).not.toHaveBeenCalled();
    expect(within(favorites).getAllByRole("button", { name: "Copy password" })).toHaveLength(2);
    expect(within(favorites).getAllByRole("button", { name: "View info" })).toHaveLength(2);
  });

  it("hides Copy password on a favorite the plan locks", async () => {
    await setup();
    act(() => useTierStore.setState({ lockedEntryIds: new Set(["s"]) } as never));
    const favorites = card("Favorites");
    expect(within(favorites).getAllByRole("button", { name: "Copy password" })).toHaveLength(1);
    expect(within(favorites).getAllByRole("button", { name: "View info" })).toHaveLength(2);
  });

  it("draws the vault status rows as list rows in sentence case and shows only the overview tiles with entries", async () => {
    await setup({ maxConnections: 3, trialDays: 2 });
    const status = card("Vault status");
    const local = within(status).getByText("Local backup");
    expect(local.closest(".h-row")).not.toBeNull();
    expect(within(status).getByText("Disabled").closest(".text-meta")).toHaveClass("text-ink-faint");
    expect(local.closest(".h-row")!.querySelector("[data-status] svg")).not.toBeNull();
    expect(within(status).getByText("Plan usage")).toBeInTheDocument();
    expect(within(status).getByText("3/3")).toBeInTheDocument();
    expect(within(status).getByText("2 days remaining")).toHaveClass("text-danger");
    const overview = card("Overview");
    expect(overview.querySelector(".grid-cols-3")).not.toBeNull();
    const tiles = [...overview.querySelectorAll("[data-cv-type-tiles] > div")].map((t) => t.textContent);
    expect(tiles).toEqual(["1SSH", "1Web", "1Command"]);
    for (const gone of ["1 credential", "1 document", "2 folders"]) expect(within(overview).queryByText(gone)).toBeNull();
  });

  it("shows the welcome block for an empty vault", async () => {
    await setup({ entries: [], folders: [] });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Welcome to Conduit");
    expect(screen.getByText("Get started by creating your first entry or connecting to a remote host.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Entry" })).toHaveClass("bg-btn-primary");
    expect(screen.getByRole("button", { name: "Quick Connect" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("treats null or missing entries, folders and credentials as empty", async () => {
    await setup();
    act(() => {
      useEntryStore.setState({ entries: null, folders: undefined } as never);
      useVaultStore.setState({ credentials: null } as never);
    });
    await act(async () => undefined);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Welcome to Conduit");

    act(() => useEntryStore.setState({ entries: ENTRIES.map((e) => ({ ...e, tags: null })), folders: null } as never));
    await act(async () => undefined);
    expect(screen.getByText("5 entries · 0 credentials · 0 folders")).toBeInTheDocument();
    expect(card("Overview")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "web" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["web-01SSH"]);
  });

  it("reloads Recently connected after Clear connection history", async () => {
    api.historyClear.mockResolvedValue({ deleted: 1 });
    await setup();
    await screen.findByText("Recently connected");
    const before = api.historyRecent.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear connection history..." }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Clear history" }));
    await waitFor(() => expect(api.historyRecent.mock.calls.length).toBe(before + 1));
  });
});
