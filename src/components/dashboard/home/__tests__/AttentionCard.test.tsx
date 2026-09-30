import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AttentionCard from "../AttentionCard";
import { dashboardApi } from "../../../../lib/dashboardApi";
import { openDashboardForEntry } from "../../../../lib/openDashboard";
import { useEntryStore } from "../../../../stores/entryStore";
import { useSyncStore } from "../../../../stores/syncStore";
import { useTierStore } from "../../../../stores/tierStore";
import { useVaultStore } from "../../../../stores/vaultStore";
import { DEFAULT_HOME_SETTINGS, type HomeSettings, type PasswordAgeItem } from "../../../../types/dashboard";
import { entry, minutesAgo, rowParts } from "../../__tests__/fixtures";
import { seedHomeStores } from "./homeTestStores";

const invoke = vi.hoisted(() => {
  const fn = vi.fn(async (_channel: string, _args?: unknown): Promise<unknown> => null);
  Object.assign(globalThis, { electron: { invoke: fn, on: () => () => undefined } });
  return fn;
});
vi.mock("../../../../lib/dashboardApi", () => ({ dashboardApi: { passwordAges: vi.fn() } }));
vi.mock("../../../../lib/openDashboard", () => ({ openDashboardForEntry: vi.fn(), openFolderView: vi.fn() }));

const ages = vi.mocked(dashboardApi.passwordAges);
const DAY_MINUTES = 60 * 24;

const ENTRIES = Array.from({ length: 12 }, (_, i) => entry({ id: `e${i}`, name: `server-${String(i).padStart(2, "0")}`, entry_type: "ssh" }));
const OLD: PasswordAgeItem[] = ENTRIES.map((e, i) => ({ entryId: e.id, setAt: minutesAgo((200 + i * 30) * DAY_MINUTES), source: "created" }));

function setup(settings: HomeSettings = DEFAULT_HOME_SETTINGS, items: PasswordAgeItem[] = OLD) {
  ages.mockResolvedValue(items);
  seedHomeStores({ entries: ENTRIES });
  return render(<AttentionCard settings={settings} />);
}

beforeEach(() => {
  ages.mockReset();
  invoke.mockClear();
  vi.mocked(openDashboardForEntry).mockReset();
});

afterEach(() => vi.useRealTimers());

describe("AttentionCard", () => {
  it("shows the password item and toggles its list, oldest first, capped at ten", async () => {
    setup();
    const title = await screen.findByText("12 passwords older than 180 days");
    const item = title.closest("[data-attention]") as HTMLElement;
    expect(within(item).getByText("Change old passwords to keep your accounts safe.")).toHaveClass("text-meta", "text-ink-muted");
    expect(item.querySelector("svg.text-warning")).not.toBeNull();
    fireEvent.click(within(item).getByRole("button", { name: "Show" }));
    const rows = within(item).getAllByRole("button").filter((b) => b.textContent !== "Hide");
    expect(rows).toHaveLength(10);
    expect(rowParts(rows[0])).toEqual({ label: "server-11", meta: "1 year old" });
    expect(rowParts(rows[9])).toEqual({ label: "server-02", meta: "8 months old" });
    expect(within(item).getByText("And 2 more")).toBeInTheDocument();
    fireEvent.click(rows[0]);
    expect(openDashboardForEntry).toHaveBeenCalledWith("e11");
    fireEvent.click(within(item).getByRole("button", { name: "Hide" }));
    expect(within(item).queryByText("server-11")).toBeNull();
  });

  it("does not load password ages when the warning is off", async () => {
    const { container } = setup({ ...DEFAULT_HOME_SETTINGS, passwordAgeDays: null });
    await act(async () => undefined);
    expect(ages).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("reloads password ages 1 s after the entries change", async () => {
    vi.useFakeTimers();
    setup();
    await act(async () => undefined);
    expect(ages).toHaveBeenCalledTimes(1);
    act(() => useEntryStore.setState({ entries: [...ENTRIES] }));
    await act(async () => vi.advanceTimersByTime(900));
    expect(ages).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(100));
    expect(ages).toHaveBeenCalledTimes(2);
  });

  it("hides on a load error without a toast", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ages.mockRejectedValue(new Error("locked"));
    seedHomeStores({ entries: ENTRIES });
    const { container } = render(<AttentionCard settings={DEFAULT_HOME_SETTINGS} />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("password_age_list"), expect.anything()));
    expect(container).toBeEmptyDOMElement();
    warn.mockRestore();
  });

  it("runs each action: review, settings tabs and plans", async () => {
    setup(DEFAULT_HOME_SETTINGS, []);
    const openView = vi.fn();
    act(() => {
      useSyncStore.setState({
        state: { killSwitch: false, softLocked: false, status: { kind: "error", conflictCount: 2 } },
        openView,
      } as never);
      useVaultStore.setState({ localBackupState: { enabled: true, status: "error", error: "Disk full", lastBackedUpAt: null } } as never);
      useTierStore.setState({ maxConnections: 2, isTrialing: true, trialDaysRemaining: 1 } as never);
    });
    const titles = (await screen.findAllByText(/./, { selector: "p.text-label" })).map((p) => p.textContent);
    expect(titles).toEqual(["Sync has a problem", "Local backup failed", "Your Pro trial ends tomorrow", "2 changes to review", "All 2 connections on your plan are in use"]);
    expect(screen.getByText("Sync has a problem").closest("[data-attention]")!.querySelector("svg.text-danger")).not.toBeNull();

    const tabs: string[] = [];
    const onSettings = (e: Event) => tabs.push((e as CustomEvent).detail.tab);
    document.addEventListener("conduit:settings", onSettings);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Sync settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Backup settings" }));
    for (const button of screen.getAllByRole("button", { name: "See plans" })) fireEvent.click(button);
    document.removeEventListener("conduit:settings", onSettings);
    expect(openView).toHaveBeenCalledWith({ kind: "review", row: null });
    expect(tabs).toEqual(["sync", "backup"]);
    expect(invoke.mock.calls.filter(([channel]) => channel === "auth_open_pricing")).toHaveLength(2);
  });

  it("hides when nothing needs attention", async () => {
    const { container } = setup(DEFAULT_HOME_SETTINGS, []);
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
  });
});
