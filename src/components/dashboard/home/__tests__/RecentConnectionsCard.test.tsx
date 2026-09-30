import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import RecentConnectionsCard from "../RecentConnectionsCard";
import { dashboardApi } from "../../../../lib/dashboardApi";
import { openDashboardForEntry } from "../../../../lib/openDashboard";
import { useSessionStore } from "../../../../stores/sessionStore";
import { toast } from "../../../common/Toast";
import type { RecentConnection } from "../../../../types/dashboard";
import { entry, minutesAgo, rowParts } from "../../__tests__/fixtures";
import { seedHomeStores } from "./homeTestStores";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});
vi.mock("../../../../lib/dashboardApi", () => ({ dashboardApi: { historyRecent: vi.fn() } }));
vi.mock("../../../../lib/openDashboard", () => ({ openDashboardForEntry: vi.fn(), openFolderView: vi.fn() }));
vi.mock("../../../common/Toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const recent = vi.mocked(dashboardApi.historyRecent);

function row(entryId: string, lastOutcome: RecentConnection["lastOutcome"], minutes: number): RecentConnection {
  return { entryId, protocol: "ssh", lastStartedAt: minutesAgo(minutes), lastEndedAt: null, lastDurationMs: null, lastOutcome, count: 1 };
}

const ENTRIES = [
  entry({ id: "s1", name: "web-01", entry_type: "ssh" }),
  entry({ id: "r1", name: "DC01", entry_type: "rdp" }),
  entry({ id: "w1", name: "Intranet", entry_type: "web" }),
];

function setup(rows: RecentConnection[]) {
  recent.mockResolvedValue(rows);
  const actions = seedHomeStores({ entries: ENTRIES });
  const view = render(<RecentConnectionsCard refreshKey={0} />);
  return { actions, ...view };
}

const card = () => screen.getByRole("heading", { level: 3, name: "Recently connected" }).closest(".border-card-border") as HTMLElement;
const rowButtons = () => within(card()).getAllByRole("button").filter((b) => !b.hasAttribute("aria-label"));

beforeEach(() => {
  recent.mockReset();
  vi.mocked(openDashboardForEntry).mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

afterEach(() => vi.useRealTimers());

describe("RecentConnectionsCard", () => {
  it("lists entries that still exist, with Now, Failed and the relative time", async () => {
    setup([row("s1", "open", 1), row("gone", "closed", 2), row("r1", "closed", 125), row("w1", "failed", 60 * 26)]);
    await screen.findByText("Recently connected");
    expect(recent).toHaveBeenCalledWith({ limit: 8 });
    expect(rowButtons().map(rowParts)).toEqual([
      { label: "web-01", meta: "Now" },
      { label: "DC01", meta: "2h ago" },
      { label: "Intranet", meta: "FailedYesterday" },
    ]);
    expect(within(card()).getByText("Failed")).toHaveClass("bg-danger-bg");
  });

  it("opens the entry on click and its info tab from View info", async () => {
    const { actions } = setup([row("s1", "closed", 5)]);
    await screen.findByText("web-01");
    fireEvent.click(rowButtons()[0]);
    expect(actions.openEntry).toHaveBeenCalledWith("s1");
    fireEvent.click(screen.getByRole("button", { name: "View info" }));
    expect(openDashboardForEntry).toHaveBeenCalledWith("s1");
  });

  it("copies the password with the tab menu toasts", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { actions } = setup([row("s1", "closed", 5)]);
    await screen.findByText("web-01");
    const copy = screen.getByRole("button", { name: "Copy password" });

    actions.resolveCredential.mockResolvedValueOnce({ password: "hunter2" });
    fireEvent.click(copy);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Password copied"));
    expect(writeText).toHaveBeenCalledWith("hunter2");
    expect(actions.resolveCredential).toHaveBeenCalledWith("s1");

    actions.resolveCredential.mockResolvedValueOnce({ password: null });
    fireEvent.click(copy);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("No password available"));

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeText.mockRejectedValueOnce(new Error("denied"));
    actions.resolveCredential.mockResolvedValueOnce({ password: "x" });
    fireEvent.click(copy);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't copy the password"));
  });

  it("hides when there is nothing to show or the load fails, without a toast", async () => {
    const { container, unmount } = setup([row("gone", "closed", 5)]);
    await waitFor(() => expect(recent).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recent.mockRejectedValue(new Error("nope"));
    seedHomeStores({ entries: ENTRIES });
    const second = render(<RecentConnectionsCard refreshKey={0} />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("connection_history_recent"), expect.anything()));
    expect(second.container).toBeEmptyDOMElement();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reloads 750 ms after the session ids change and when the refresh key changes", async () => {
    vi.useFakeTimers();
    const { rerender } = setup([row("s1", "closed", 5)]);
    await act(async () => undefined);
    expect(recent).toHaveBeenCalledTimes(1);
    act(() => useSessionStore.setState({ sessions: [{ id: "x", type: "ssh", title: "web-01", status: "connecting", entryId: "s1" }] }));
    await act(async () => vi.advanceTimersByTime(700));
    expect(recent).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(100));
    expect(recent).toHaveBeenCalledTimes(2);
    act(() => useSessionStore.setState({ sessions: [{ id: "x", type: "ssh", title: "web-01", status: "connected", entryId: "s1" }] }));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(recent).toHaveBeenCalledTimes(2);
    rerender(<RecentConnectionsCard refreshKey={1} />);
    await act(async () => undefined);
    expect(recent).toHaveBeenCalledTimes(3);
  });
});
