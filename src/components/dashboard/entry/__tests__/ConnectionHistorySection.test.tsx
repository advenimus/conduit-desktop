import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import ConnectionHistorySection from "../ConnectionHistorySection";
import { useSessionStore } from "../../../../stores/sessionStore";
import type { ConnectionHistoryEvent } from "../../../../types/dashboard";
import { rowParts } from "../../__tests__/fixtures";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

const historyForEntry = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/dashboardApi", () => ({ dashboardApi: { historyForEntry } }));

const at = (hour: number, minute: number) => new Date(2026, 8, 29, hour, minute).toISOString();

const event = (id: string, outcome: ConnectionHistoryEvent["outcome"], startedAt: string, durationMs: number | null): ConnectionHistoryEvent => ({
  id,
  entryId: "e1",
  protocol: "ssh",
  startedAt,
  endedAt: null,
  durationMs,
  outcome,
});

async function setup() {
  const view = render(<ConnectionHistorySection entryId="e1" />);
  await act(async () => undefined);
  return view;
}

beforeEach(() => {
  historyForEntry.mockReset();
  useSessionStore.setState({ sessions: [] } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ConnectionHistorySection", () => {
  it("titles the section and lists outcomes with date, time and duration", async () => {
    historyForEntry.mockResolvedValue([
      event("1", "open", at(15, 0), null),
      event("2", "closed", at(14, 14), 65 * 60_000),
      event("3", "failed", at(9, 2), null),
      event("4", "dropped", at(8, 40), 12 * 60_000),
      event("5", "interrupted", at(7, 5), null),
    ]);
    const { container } = await setup();
    expect(historyForEntry).toHaveBeenCalledWith({ entryId: "e1", limit: 20 });
    expect(screen.getByRole("heading", { level: 3, name: "Recent connections" })).toBeInTheDocument();
    expect(screen.getByText("Connections from this device only.")).toBeInTheDocument();
    const rows = [...container.querySelectorAll<HTMLElement>(".group\\/row")];
    expect(rows.every((row) => row.tagName === "DIV")).toBe(true);
    expect(rows.map(rowParts)).toEqual([
      { label: "Connected now", meta: "Sep 29, 3:00 PM" },
      { label: "Connected", meta: "Sep 29, 2:14 PM · 1 h 5 min" },
      { label: "Could not connect", meta: "Sep 29, 9:02 AM" },
      { label: "Disconnected with an error", meta: "Sep 29, 8:40 AM · 12 min" },
      { label: "Ended when Conduit closed", meta: "Sep 29, 7:05 AM" },
    ]);
    expect(rows[2].querySelector("svg")?.getAttribute("class")).toContain("text-danger");
    expect(rows[0].parentElement).toHaveClass("-mx-2");
  });

  it("says when there is no history", async () => {
    historyForEntry.mockResolvedValue([]);
    await setup();
    expect(screen.getByText("No connections from this device yet.")).toHaveClass("text-label", "text-ink-faint");
  });

  it("shows the empty line and logs when the load fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    historyForEntry.mockRejectedValue(new Error("boom"));
    await setup();
    expect(screen.getByText("No connections from this device yet.")).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith("connection_history_for_entry failed", expect.any(Error));
  });

  it("reloads 750 ms after the session ids change", async () => {
    vi.useFakeTimers();
    historyForEntry.mockResolvedValue([]);
    await setup();
    expect(historyForEntry).toHaveBeenCalledTimes(1);
    act(() => useSessionStore.setState({ sessions: [{ id: "s1" }] } as never));
    act(() => vi.advanceTimersByTime(500));
    act(() => useSessionStore.setState({ sessions: [{ id: "s1" }, { id: "s2" }] } as never));
    act(() => vi.advanceTimersByTime(700));
    expect(historyForEntry).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(60));
    expect(historyForEntry).toHaveBeenCalledTimes(2);
  });
});
