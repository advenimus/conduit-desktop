import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import WhatsNewDialog from "../WhatsNewDialog";
import type { ReleaseEntry } from "../../../types/whats-new";
import { clickScrim, closeButton, pressEscape, topPanel } from "../../common/__tests__/dialogClose";

const notes = vi.hoisted(() => ({ value: { releases: [] as ReleaseEntry[], loading: false, error: null as string | null, retry: () => {} } }));
vi.mock("../useReleaseNotes", () => ({
  useReleaseNotes: () => notes.value,
  getMediaUrl: (version: string) => `media/${version}.gif`,
}));

const RELEASES: ReleaseEntry[] = [
  { version: "2.0.0", date: "2026-09-28", title: "A Fresh Look", summary: "Cleaner look", highlights: [{ text: "**Refreshed tabs**: compact", category: "improvement" }], hasMedia: false },
  { version: "1.9.0", date: "2026-08-01", title: "Older", summary: "Older summary", highlights: [{ text: "See [Settings](conduit://settings/appearance)" }], hasMedia: false },
];

beforeEach(() => {
  vi.useFakeTimers();
  notes.value = { releases: RELEASES, loading: false, error: null, retry: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WhatsNewDialog", () => {
  it("keeps the release card: navigation, title, highlights, dots and Close", () => {
    render(<WhatsNewDialog onClose={() => {}} />);
    const panel = topPanel();
    expect(panel).toHaveStyle({ maxWidth: "896px" });
    expect(screen.getByTitle("Previous version")).toBeDisabled();
    expect(screen.getByTitle("Next version")).toBeEnabled();
    expect(panel).toHaveTextContent("1 / 2");
    expect(screen.getByText("A Fresh Look")).toBeInTheDocument();
    expect(panel).toHaveTextContent("v2.0.0");
    expect(screen.getByText("Refreshed tabs")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Close" }).map((b) => b.textContent)).toEqual(["", "Close"]);
  });

  it("pages with the arrow keys and the dots", () => {
    render(<WhatsNewDialog onClose={() => {}} />);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText("Older")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("shows the loading and the unavailable states with their texts", () => {
    notes.value = { releases: [], loading: true, error: null, retry: vi.fn() };
    const { rerender } = render(<WhatsNewDialog onClose={() => {}} />);
    expect(topPanel()).toHaveTextContent("Loading release notes...");
    notes.value = { releases: [], loading: false, error: "Offline", retry: vi.fn() };
    rerender(<WhatsNewDialog onClose={() => {}} />);
    expect(topPanel()).toHaveTextContent("Release notes unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(notes.value.retry).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape, a scrim click and its close button (3.12.1)", () => {
    const onClose = vi.fn();
    render(<WhatsNewDialog onClose={onClose} />);
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    clickScrim();
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(closeButton() as HTMLButtonElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
