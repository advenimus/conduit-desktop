import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import Sidebar from "../Sidebar";
import { useAuthStore } from "../../../stores/authStore";
import { useEntryStore } from "../../../stores/entryStore";
import { useSidebarStore } from "../../../stores/sidebarStore";
import { useSyncStore } from "../../../stores/syncStore";
import { useTeamStore, type TeamVaultSummary } from "../../../stores/teamStore";
import { useTierStore } from "../../../stores/tierStore";
import { useVaultStore } from "../../../stores/vaultStore";
import type { SyncStateResponse, SyncStatus } from "../../../types/sync";
import type { EntryMeta, FolderData } from "../../../types/entry";

// Stores read settings through window.electron while these modules load.
vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

const VAULT_PATH = "/tmp/vaults/Acme Infrastructure.conduit";
const LONG_NAME = "A".repeat(30) + "B".repeat(30);

const TEAM_VAULT: TeamVaultSummary = {
  id: "tv1",
  team_id: "t1",
  name: "Acme Team Vault",
  description: null,
  created_by: "u1",
  member_count: 1,
  created_at: "",
  updated_at: "",
};

function syncState(conflictCount = 0): SyncStateResponse {
  const status: SyncStatus = {
    lineageId: "l1",
    fileName: null,
    kind: "up-to-date",
    pauseReason: null,
    waiting: null,
    pendingPublish: false,
    unsyncedOps: 0,
    conflictCount,
    lastSyncedMs: null,
    backoffUntilMs: null,
    sessionBadge: null,
    networkRoot: false,
    prompts: [],
    otherCopies: [],
  };
  return {
    enabled: true,
    killSwitch: false,
    vault: null,
    status,
    deviceLimit: null,
    sideFiles: [],
    notices: [],
    pendingVaults: [],
    softLocked: false,
    ownership: null,
    deviceCap: null,
  };
}

const ENTRIES = [
  { id: "e1", name: "db-01", entry_type: "ssh", folder_id: null, sort_order: 0, is_favorite: true },
  { id: "e2", name: "Runbook", entry_type: "document", folder_id: null, sort_order: 1, is_favorite: false },
] as unknown as EntryMeta[];
const FOLDERS = [{ id: "f1", name: "Production", parent_id: null, sort_order: 0 }] as unknown as FolderData[];

interface Setup {
  signedIn?: "authenticated" | "cached";
  team?: "editor" | "viewer";
  vaultPath?: string;
  trialCard?: boolean;
  trial?: { days: number; urgency: "none" | "moderate" | "urgent" };
  onboarding?: boolean;
  review?: number;
  docked?: boolean;
}

function setup(opts: Setup = {}) {
  const team = opts.team;
  useSidebarStore.setState({
    isExpanded: true,
    isPinned: opts.docked ?? true,
    viewportWidth: 1280,
    expandedWidth: 250,
    rightPanelWidth: 0,
  });
  useVaultStore.setState({
    isUnlocked: true,
    currentVaultPath: opts.vaultPath ?? VAULT_PATH,
    recentVaults: [],
    isNetworkVault: false,
    vaultType: team ? "team" : "personal",
    teamVaultId: team ? TEAM_VAULT.id : null,
    teamSyncState: team ? { status: "synced", lastSyncedAt: null, error: null, pendingChanges: 0 } : null,
    cloudSyncState: null,
    fetchTeamSyncState: vi.fn(async () => undefined),
  } as never);
  useEntryStore.setState({ entries: ENTRIES, folders: FOLDERS, loadAll: vi.fn(async () => undefined) } as never);
  useAuthStore.setState({
    user: opts.signedIn ? ({ id: "u1", email: "ops@example.com" } as never) : null,
    authMode: opts.signedIn ?? "local",
    isTeamMember: Boolean(team) || Boolean(opts.onboarding),
    signOut: vi.fn(async () => undefined),
  } as never);
  useTeamStore.setState({
    team: team || opts.onboarding ? ({ id: "t1" } as never) : null,
    teamVaults: team ? [TEAM_VAULT] : [],
    myRole: opts.onboarding ? "admin" : team ? "member" : null,
    pendingInvitations: [],
    checkInvitations: vi.fn(async () => undefined),
    canCreate: () => team !== "viewer",
    getEffectiveRole: () => team ?? null,
  } as never);
  useTierStore.setState({
    trialEligible: Boolean(opts.trialCard),
    isTrialing: Boolean(opts.trial),
    trialDaysRemaining: opts.trial?.days ?? 0,
    trialUrgency: opts.trial?.urgency ?? "none",
  } as never);
  useSyncStore.setState({ state: team ? null : syncState(opts.review ?? 0) } as never);
  return render(<Sidebar />);
}

const header = () => document.querySelector("[data-cv-sidebar-header]") as HTMLElement;
const footer = () => document.querySelector("[data-cv-sidebar-footer]") as HTMLElement;
const buttonsIn = (el: HTMLElement) => [...el.querySelectorAll("button")];
const describeButton = (b: HTMLButtonElement) => ({
  text: b.textContent?.trim() || undefined,
  title: b.getAttribute("title") ?? undefined,
  aria: b.getAttribute("aria-label") ?? undefined,
  pressed: b.getAttribute("aria-pressed") ?? undefined,
});

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("electron", {
    invoke: vi.fn(async () => null),
    on: vi.fn(() => () => undefined),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sidebar header", () => {
  it("keeps today's controls in today's order, titles and names", () => {
    setup();
    expect(header().className).toContain("h-tabstrip");
    expect(buttonsIn(header()).map(describeButton)).toEqual([
      { title: "Hide sidebar (Ctrl+B)", aria: "Hide sidebar", text: undefined, pressed: undefined },
      { title: "Unpin sidebar so it auto-hides (Ctrl+Shift+B)", aria: "Unpin sidebar", text: undefined, pressed: "true" },
      { text: "Acme Infrastructure", title: VAULT_PATH, aria: undefined, pressed: undefined },
      { title: "Show favorites only", aria: "Show favorites only", text: undefined, pressed: undefined },
      { title: "New Entry (Ctrl+E)", aria: "New Entry", text: undefined, pressed: undefined },
      { title: "New Folder (Ctrl+Shift+N)", aria: "New Folder", text: undefined, pressed: undefined },
    ]);
    expect(header().querySelector("[data-cv-vault-switcher]")?.textContent).toBe("Acme Infrastructure");
  });

  it("truncates a 60-character vault name before the buttons and keeps all six clickable", () => {
    setup({ vaultPath: `/tmp/vaults/${LONG_NAME}.conduit` });
    const switcher = header().querySelector("[data-cv-vault-switcher]") as HTMLButtonElement;
    const name = within(switcher).getByText(LONG_NAME);
    expect(name.className).toMatch(/\bmin-w-0\b/);
    expect(name.className).toMatch(/\btruncate\b/);
    expect(switcher.className).toMatch(/\bmin-w-0\b/);
    expect(switcher.className).toMatch(/\bmax-w-full\b/);
    const wrapper = switcher.parentElement as HTMLElement;
    expect(wrapper.className).toMatch(/\bflex-1\b/);
    expect(wrapper.className).toMatch(/\bmin-w-0\b/);
    const rightGroup = wrapper.nextElementSibling as HTMLElement;
    expect(rightGroup.className).toMatch(/\bshrink-0\b/);
    for (const b of buttonsIn(header())) expect(b.className).not.toMatch(/\babsolute\b/);

    const events: string[] = [];
    const record = (e: Event) => events.push(e.type);
    document.addEventListener("conduit:new-entry", record);
    document.addEventListener("conduit:new-folder", record);
    const togglePin = vi.fn();
    const collapse = vi.fn();
    useSidebarStore.setState({ togglePin, collapse });

    fireEvent.click(screen.getByRole("button", { name: "New Entry" }));
    fireEvent.click(screen.getByRole("button", { name: "New Folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Show favorites only" }));
    expect(screen.getByRole("button", { name: "Show all entries" })).toBeTruthy();
    fireEvent.click(switcher);
    expect(screen.getByText("Lock Current Vault")).toBeTruthy();
    fireEvent.click(switcher);
    fireEvent.click(screen.getByRole("button", { name: "Unpin sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));

    expect(events).toEqual(["conduit:new-entry", "conduit:new-folder"]);
    expect(togglePin).toHaveBeenCalledTimes(1);
    expect(collapse).toHaveBeenCalledTimes(1);
    document.removeEventListener("conduit:new-entry", record);
    document.removeEventListener("conduit:new-folder", record);
  });

  it("draws the favorites filter as a filled star in the favorite color while it is on", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Show favorites only" }));
    const on = screen.getByRole("button", { name: "Show all entries" });
    expect(on.className).toContain("text-favorite");
    expect(on.className).not.toContain("text-ink-muted");
    expect(within(footer()).getByText("1 favorite")).toBeTruthy();
  });

  it("disables both create buttons on a view-only team vault", () => {
    setup({ team: "viewer", signedIn: "authenticated" });
    const entry = screen.getByRole("button", { name: "New Entry" }) as HTMLButtonElement;
    const folder = screen.getByRole("button", { name: "New Folder" }) as HTMLButtonElement;
    expect(entry.disabled && folder.disabled).toBe(true);
    expect(entry.title).toBe("View-only access");
    expect(folder.title).toBe("View-only access");
  });
});

describe("Sidebar vault switcher menu", () => {
  it("opens under the switcher with today's rows as buttons", () => {
    setup();
    fireEvent.click(header().querySelector("[data-cv-vault-switcher]")!);
    const menu = header().querySelector("[data-context-menu]") as HTMLElement;
    expect(menu.className).toContain("w-[280px]");
    expect(menu.className).toContain("bg-overlay");
    expect(menu.textContent).toContain("Personal Vaults");
    expect(menu.className).not.toContain("uppercase");
    expect(buttonsIn(menu).map((b) => b.textContent?.trim())).toEqual([
      "Acme Infrastructure",
      "New Vault...",
      "Open Vault File...",
      "Lock Current Vault",
      "Switch Vault...",
    ]);
  });
});

describe("Sidebar body", () => {
  it("keeps the search field, its placeholder and the clear button", () => {
    setup();
    const search = document.querySelector("[data-cv-sidebar-search]") as HTMLElement;
    const input = within(search).getByPlaceholderText("Search entries...") as HTMLInputElement;
    expect(within(search).queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.change(input, { target: { value: "web" } });
    const clear = within(search).getByRole("button", { name: "Clear search" });
    expect(clear.title).toBe("Clear search");
    fireEvent.click(clear);
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "db" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });

  it("orders the rows of L-6: header, search, tree, footer", () => {
    setup();
    const panel = document.querySelector("[data-sidebar-panel]") as HTMLElement;
    const rows = [...panel.children] as HTMLElement[];
    const index = (el: Element | null) => rows.findIndex((r) => r === el || r.contains(el));
    const head = index(header());
    const search = index(document.querySelector("[data-cv-sidebar-search]"));
    const tree = index(screen.getByText("db-01"));
    const foot = index(footer());
    expect(head).toBeLessThan(search);
    expect(search).toBeLessThan(tree);
    expect(tree).toBeLessThan(foot);
    expect(foot).toBe(rows.length - 2);
    expect(rows[rows.length - 1].className).toContain("cursor-col-resize");
  });
});

describe("Sidebar footer", () => {
  it("keeps the count, the sync button, Home and Settings, then the local-mode sign-in link", () => {
    setup();
    expect(footer().className).toContain("border-divider");
    const [row1, row2] = [...footer().children] as HTMLElement[];
    expect(row1.className).toContain("h-8");
    expect(row1.firstElementChild?.firstElementChild?.textContent).toBe("3 items");
    expect(buttonsIn(row1).map(describeButton)).toEqual([
      { aria: "Sync: Up to date", title: expect.stringContaining("Up to date"), text: undefined, pressed: undefined },
      { title: "Home", aria: "Home", text: undefined, pressed: undefined },
      { title: "Settings (Ctrl+,)", aria: "Settings", text: undefined, pressed: undefined },
    ]);
    expect(buttonsIn(row2).map((b) => b.textContent?.trim())).toEqual(["Sign in to start a free Pro trial"]);
  });

  it("opens Settings > Sync from the sync button", () => {
    setup();
    const tabs: unknown[] = [];
    const record = (e: Event) => tabs.push((e as CustomEvent).detail);
    document.addEventListener("conduit:settings", record);
    fireEvent.click(screen.getByRole("button", { name: "Sync: Up to date" }));
    document.removeEventListener("conduit:settings", record);
    expect(tabs).toEqual([{ tab: "sync" }]);
  });

  it("shows the review button with its title and hook", () => {
    setup({ review: 3 });
    const review = within(footer()).getByText("3 to review");
    expect(review.tagName).toBe("BUTTON");
    expect(review.title).toBe("Review changes from your other devices");
    expect(review.hasAttribute("data-cv-review-button")).toBe(true);
  });

  it("signed in: row 2 holds the email, then Sign Out, which asks to Confirm or Cancel", () => {
    setup({ signedIn: "authenticated" });
    const row2 = footer().children[1] as HTMLElement;
    expect(row2.className).toContain("border-t");
    expect(buttonsIn(row2).map(describeButton)).toEqual([
      { text: "ops@example.com", title: "Account Settings", aria: undefined, pressed: undefined },
      { title: "Sign Out", aria: "Sign Out", text: undefined, pressed: undefined },
    ]);
    expect(within(row2).queryByText("offline")).toBeNull();

    fireEvent.click(within(row2).getByRole("button", { name: "Sign Out" }));
    expect(buttonsIn(row2).map((b) => b.textContent?.trim())).toEqual(["ops@example.com", "Confirm", "Cancel"]);
    fireEvent.click(within(row2).getByRole("button", { name: "Cancel" }));
    expect(within(row2).getByRole("button", { name: "Sign Out" })).toBeTruthy();
  });

  it("signs out after Confirm", async () => {
    setup({ signedIn: "authenticated" });
    fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });
    expect(useAuthStore.getState().signOut).toHaveBeenCalledTimes(1);
  });

  it("cached mode: the offline badge follows the email", () => {
    setup({ signedIn: "cached" });
    const row2 = footer().children[1] as HTMLElement;
    const email = within(row2).getByRole("button", { name: "ops@example.com" });
    const badge = within(row2).getByText("offline");
    expect(badge.tagName).toBe("SPAN");
    expect(email.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(badge.className).toContain("text-warning");
  });
});

describe("Sidebar team vault", () => {
  it("tints the header and shows the team context bar with its dot and settings", () => {
    setup({ team: "editor", signedIn: "authenticated" });
    expect(header().className).toContain("bg-team");
    expect(header().className).toContain("border-l-team-border-strong");
    expect(within(header()).getByRole("button", { name: /Acme Team Vault/ }).textContent).toBe("Acme Team Vault");

    const bar = header().nextElementSibling as HTMLElement;
    expect(bar.className).toContain("h-section");
    expect(bar.className).toContain("bg-team");
    expect(within(bar).getByTitle("Synced").tagName).toBe("SPAN");
    expect(within(bar).getByText("Team")).toBeTruthy();
    const settings = within(bar).getByRole("button", { name: "Vault settings" });
    expect(settings.title).toBe("Vault settings");

    const teamSync = within(footer()).getByTitle(/^Team vault synced/);
    expect(teamSync.tagName).toBe("DIV");
    expect(teamSync.className).toContain("text-info");
  });
});

describe("Sidebar cards", () => {
  it("shows the trial card with today's texts and dismisses it", () => {
    setup({ signedIn: "authenticated", trialCard: true });
    const title = screen.getByText("Try Pro free for 30 days");
    const card = title.closest(".rounded-md") as HTMLElement;
    expect(card.className).toContain("bg-info-bg");
    expect(buttonsIn(card).map(describeButton)).toEqual([
      { text: "Start Free Trial →", title: undefined, aria: undefined, pressed: undefined },
      { title: "Dismiss", aria: "Dismiss", text: undefined, pressed: undefined },
    ]);
    const tree = screen.getByText("db-01");
    expect(tree.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(footer()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Try Pro free for 30 days")).toBeNull();
    expect(localStorage.getItem("conduit:trial-promo-dismissed")).toBe("true");
  });

  it("shows the trial strip above the footer with the day count and the tone", () => {
    setup({ signedIn: "authenticated", trial: { days: 5, urgency: "none" } });
    const strip = screen.getByText("Pro Trial — 5 days left").parentElement as HTMLElement;
    expect(strip.className).toContain("h-7");
    expect(strip.className).toContain("bg-info-bg");
    expect(strip.nextElementSibling).toBe(footer());
  });

  it("colors an urgent trial strip as danger and says 1 day", () => {
    setup({ signedIn: "authenticated", trial: { days: 1, urgency: "urgent" } });
    const strip = screen.getByText("Pro Trial — 1 day left").parentElement as HTMLElement;
    expect(strip.className).toContain("text-danger");
    expect(strip.className).toContain("bg-danger-bg");
  });

  it("shows the admin onboarding card under the header and dismisses it", () => {
    setup({ signedIn: "authenticated", onboarding: true });
    const title = screen.getByText("Create your first team vault");
    const card = title.closest(".rounded-md") as HTMLElement;
    expect(within(card).getByText("Share credentials securely with your team.")).toBeTruthy();
    expect(buttonsIn(card).map((b) => b.textContent?.trim() || b.title)).toEqual(["Create Team Vault", "Dismiss"]);
    fireEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Create your first team vault")).toBeNull();
    expect(localStorage.getItem("conduit:team-onboarding-dismissed")).toBe("true");
  });
});
