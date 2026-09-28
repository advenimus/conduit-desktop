import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import DashboardOverview from "../DashboardOverview";
import { useAuthStore } from "../../../stores/authStore";
import { useEntryStore } from "../../../stores/entryStore";
import { useSyncStore } from "../../../stores/syncStore";
import { useTierStore } from "../../../stores/tierStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { entry, folder, rowParts } from "./fixtures";

// Stores read settings through window.electron while these modules load.
vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

const ENTRIES = [
  entry({ id: "w", name: "Intranet Status", entry_type: "web", is_favorite: true, tags: ["prod"] }),
  entry({ id: "s", name: "web-01", entry_type: "ssh", is_favorite: true }),
  entry({ id: "d", name: "Runbook", entry_type: "document" }),
  entry({ id: "c", name: "Domain Admin", entry_type: "credential" }),
];

const setSelectedEntry = vi.fn();
const openEntry = vi.fn();

interface Setup {
  trialDays?: number;
  maxConnections?: number;
  entries?: typeof ENTRIES;
}

function setup(opts: Setup = {}) {
  useEntryStore.setState({
    entries: opts.entries ?? ENTRIES,
    folders: [folder({ id: "f1", name: "Production" }), folder({ id: "f2", name: "Staging" })],
    setSelectedEntry,
    openEntry,
  } as never);
  useVaultStore.setState({
    cloudSyncState: null,
    localBackupState: { status: "idle", lastBackedUpAt: null, error: null, enabled: false, backupPath: null, retentionDays: 7 },
    credentials: [{ id: "c" }],
    teamSyncState: null,
  } as never);
  useTierStore.setState({
    maxConnections: opts.maxConnections ?? -1,
    isTrialing: opts.trialDays !== undefined,
    trialDaysRemaining: opts.trialDays ?? 0,
  } as never);
  useAuthStore.setState({ authMode: "local", profile: null } as never);
  useSyncStore.setState({ state: null } as never);
  return render(<DashboardOverview />);
}

const card = (title: string) => screen.getByRole("heading", { level: 3, name: title }).closest(".border-card-border") as HTMLElement;

beforeEach(() => {
  setSelectedEntry.mockReset();
  openEntry.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DashboardOverview (restyle)", () => {
  it("sits on the editor surface", () => {
    const { container } = setup();
    expect(container.firstElementChild).toHaveClass("bg-editor");
    expect(container.querySelector(".bg-canvas, .bg-panel")).toBeNull();
  });

  it("keeps the welcome title, the counts line and Quick Connect with its Kbd hint", () => {
    setup();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Welcome back");
    expect(screen.getByText("4 entries · 1 credential · 2 folders")).toHaveClass("text-body", "text-ink-muted");
    const quick = screen.getByRole("button", { name: /Quick Connect/ });
    expect(quick).toHaveAttribute("data-cv-text-button");
    expect(quick).toHaveClass("bg-btn-primary");
    expect(quick.querySelector("kbd")).toHaveTextContent(/^(⌘N|Ctrl\+N)$/);
  });

  it("dispatches Quick Connect, search focus and tag search as before", () => {
    setup();
    const events: string[] = [];
    const listen = (name: string) => document.addEventListener(name, () => events.push(name), { once: true });
    ["conduit:quick-connect", "conduit:focus-sidebar-search", "conduit:sidebar-search"].forEach(listen);
    fireEvent.click(screen.getByRole("button", { name: /Quick Connect/ }));
    fireEvent.click(screen.getByRole("button", { name: "Search entries..." }));
    fireEvent.click(screen.getByRole("button", { name: "prod" }));
    expect(events).toEqual(["conduit:quick-connect", "conduit:focus-sidebar-search", "conduit:sidebar-search"]);
  });

  it("renders the four cards in today's order with h3 section headers", () => {
    setup();
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(["Favorites", "Recently Modified", "Vault Status", "Overview"]);
    for (const title of titles) {
      expect(card(title as string)).toHaveClass("rounded-md", "border-card-border", "bg-well");
    }
  });

  it("draws favorites as clickable rows with the type label in meta, without CSS uppercase", () => {
    setup();
    const rows = within(card("Favorites")).getAllByRole("button");
    expect(rows.map(rowParts)).toEqual([
      { label: "Intranet Status", meta: "Web" },
      { label: "web-01", meta: "SSH" },
    ]);
    for (const row of rows) {
      expect(row).toHaveClass("h-row");
      expect(row.querySelector(".uppercase")).toBeNull();
    }
  });

  it("draws recently modified rows with the relative time in meta, always visible", () => {
    setup();
    const rows = within(card("Recently Modified")).getAllByRole("button");
    expect(rows.map((r) => rowParts(r).label)).toEqual(["Intranet Status", "web-01", "Runbook"]);
    for (const row of rows) {
      const meta = row.querySelector(".text-meta.text-ink-faint") as HTMLElement;
      expect(meta).toHaveTextContent("13m ago");
      expect(meta.className).not.toMatch(/opacity-0/);
    }
  });

  it("selects on click and opens on double-click", () => {
    setup();
    const row = within(card("Recently Modified")).getByRole("button", { name: /web-01/ });
    fireEvent.click(row);
    expect(setSelectedEntry).toHaveBeenCalledWith("s");
    fireEvent.doubleClick(row);
    expect(openEntry).toHaveBeenCalledWith("s");
  });

  it("keeps the empty texts", () => {
    setup({ entries: [] });
    expect(within(card("Favorites")).getByText("Star entries to add them here")).toBeInTheDocument();
    expect(within(card("Recently Modified")).getByText("No recent entries")).toBeInTheDocument();
  });

  it("colors the status dots and the usage bar with tokens", () => {
    setup({ maxConnections: 3, trialDays: 2 });
    const status = card("Vault Status");
    expect(within(status).getByText("Local Backup")).toBeInTheDocument();
    expect(within(status).getByText("Disabled")).toBeInTheDocument();
    expect(within(status).getByText("Plan Usage")).toBeInTheDocument();
    expect(within(status).getByText("2/3")).toBeInTheDocument();
    expect(within(status).getByText("2 days remaining")).toHaveClass("text-danger");
    expect(status.querySelector("[style*='width']")).toHaveClass("bg-accent");
    expect(status.innerHTML).not.toMatch(/(red|yellow|green)-400|conduit-/);
  });

  it("keeps the overview tiles and counts", () => {
    setup();
    const overview = card("Overview");
    for (const label of ["SSH", "RDP", "VNC", "Web"]) expect(within(overview).getByText(label)).toBeInTheDocument();
    expect(within(overview).getByText("1 credential")).toBeInTheDocument();
    expect(within(overview).getByText("1 document")).toBeInTheDocument();
    expect(within(overview).getByText("2 folders")).toBeInTheDocument();
  });
});
