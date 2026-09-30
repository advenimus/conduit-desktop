import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AiActivityCard from "../AiActivityCard";
import { toolLabel } from "../aiActivityLabels";
import { dashboardApi } from "../../../../lib/dashboardApi";
import { openDashboardForEntry } from "../../../../lib/openDashboard";
import type { AiActivityItem } from "../../../../types/dashboard";
import { entry, minutesAgo } from "../../__tests__/fixtures";
import { seedHomeStores } from "./homeTestStores";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});
vi.mock("../../../../lib/dashboardApi", () => ({ dashboardApi: { aiActivity: vi.fn() } }));
vi.mock("../../../../lib/openDashboard", () => ({ openDashboardForEntry: vi.fn(), openFolderView: vi.fn() }));

const activity = vi.mocked(dashboardApi.aiActivity);

function item(o: Partial<AiActivityItem>): AiActivityItem {
  return { at: minutesAgo(2), tool: "terminal_execute", outcome: "success", durationMs: 10, entryId: null, sessionId: null, ...o };
}

const ITEMS = [
  item({ tool: "terminal_execute", entryId: "e1" }),
  item({ tool: "website_screenshot", sessionId: "s1", outcome: "error", at: minutesAgo(9) }),
  item({ tool: "entry_list", outcome: "rate_limited" }),
  item({ tool: "credential_read", outcome: "access_denied", entryId: "gone" }),
];

function setup(items = ITEMS, logFound = true) {
  activity.mockResolvedValue({ items, logFound });
  seedHomeStores({
    entries: [entry({ id: "e1", name: "web-01", entry_type: "ssh" })],
    sessions: [{ id: "s1", type: "web", title: "Intranet", status: "connected" }],
  });
  return render(<AiActivityCard className="md:col-span-2" />);
}

beforeEach(() => {
  activity.mockReset();
  vi.mocked(openDashboardForEntry).mockReset();
});

afterEach(() => vi.useRealTimers());

describe("toolLabel", () => {
  it("turns underscores into spaces and capitalizes the first letter", () => {
    expect(toolLabel("terminal_execute")).toBe("Terminal execute");
    expect(toolLabel("rdp_screenshot")).toBe("Rdp screenshot");
  });
});

describe("AiActivityCard", () => {
  it("shows the header, labels, targets, badges and times", async () => {
    setup();
    await screen.findByText("AI activity");
    expect(activity).toHaveBeenCalledWith({ limit: 5 });
    expect(screen.getByText("Recent tool calls from AI agents on this device")).toBeInTheDocument();
    expect(screen.getByText("Terminal execute · web-01")).toBeInTheDocument();
    expect(screen.getByText("Website screenshot · Intranet")).toBeInTheDocument();
    expect(screen.getByText("Entry list")).toBeInTheDocument();
    expect(screen.getByText("Credential read")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toHaveClass("bg-danger-bg");
    expect(screen.getByText("Rate limited")).toHaveClass("bg-warning-bg");
    expect(screen.getByText("Denied")).toHaveClass("bg-danger-bg");
    expect(screen.getByText("9m ago")).toBeInTheDocument();
    expect(screen.getByText("AI activity").closest(".border-card-border")).toHaveClass("md:col-span-2");
  });

  it("opens entry info only for rows whose entry exists", async () => {
    setup();
    await screen.findByText("AI activity");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Terminal execute/ }));
    expect(openDashboardForEntry).toHaveBeenCalledWith("e1");
  });

  it("hides without an audit log, without items, or on error", async () => {
    const a = setup(ITEMS, false);
    await waitFor(() => expect(activity).toHaveBeenCalled());
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    const b = setup([], true);
    await act(async () => undefined);
    expect(b.container).toBeEmptyDOMElement();
    b.unmount();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    activity.mockRejectedValue(new Error("read failed"));
    const c = render(<AiActivityCard />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("ai_activity_recent"), expect.anything()));
    expect(c.container).toBeEmptyDOMElement();
    warn.mockRestore();
  });

  it("polls every 30 s while the window is visible", async () => {
    vi.useFakeTimers();
    let visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
    const { unmount } = setup();
    await act(async () => undefined);
    expect(activity).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(activity).toHaveBeenCalledTimes(2);
    visibility = "hidden";
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(activity).toHaveBeenCalledTimes(2);
    visibility = "visible";
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(activity).toHaveBeenCalledTimes(3);
    unmount();
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(activity).toHaveBeenCalledTimes(3);
  });
});
