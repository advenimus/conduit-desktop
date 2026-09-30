import { describe, expect, it } from "vitest";
import { OUTCOME_LOOK, formatDuration, formatStartedAt, historyMeta } from "../historyFormat";

describe("formatDuration", () => {
  it("uses seconds under a minute, minutes under an hour, then hours and minutes", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(59_999)).toBe("59 s");
    expect(formatDuration(60_000)).toBe("1 min");
    expect(formatDuration(12 * 60_000 + 30_000)).toBe("12 min");
    expect(formatDuration(59 * 60_000 + 59_000)).toBe("59 min");
    expect(formatDuration(65 * 60_000)).toBe("1 h 5 min");
    expect(formatDuration(3 * 3_600_000)).toBe("3 h 0 min");
  });
});

describe("historyMeta", () => {
  const startedAt = new Date(2026, 8, 29, 14, 14).toISOString();

  it("shows the date and time, plus the duration when known", () => {
    expect(formatStartedAt(startedAt)).toBe("Sep 29, 2:14 PM");
    expect(historyMeta({ startedAt, durationMs: 65 * 60_000 })).toBe("Sep 29, 2:14 PM · 1 h 5 min");
    expect(historyMeta({ startedAt, durationMs: null })).toBe("Sep 29, 2:14 PM");
  });
});

describe("OUTCOME_LOOK", () => {
  it("labels and colors every outcome", () => {
    expect(OUTCOME_LOOK).toEqual({
      open: { label: "Connected now", icon: "circleFilled", className: "text-(--c-state-connected)" },
      closed: { label: "Connected", icon: "circleCheck", className: "text-(--c-state-connected)" },
      dropped: { label: "Disconnected with an error", icon: "alertTriangle", className: "text-warning" },
      failed: { label: "Could not connect", icon: "circleX", className: "text-danger" },
      interrupted: { label: "Ended when Conduit closed", icon: "clock", className: "text-ink-faint" },
    });
  });
});
