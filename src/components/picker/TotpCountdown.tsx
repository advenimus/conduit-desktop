import { cx } from "../ui";

const RADIUS = 10;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const LOW_SECONDS = 5;

/** A progress ring, not an icon: it draws the same in every icon pack. */
export default function TotpCountdown({ remaining, period }: { remaining: number; period: number }) {
  const offset = CIRCUMFERENCE * (1 - remaining / period);
  const isLow = remaining <= LOW_SECONDS;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <svg width="24" height="24" viewBox="0 0 24 24" className="shrink-0" aria-hidden="true">
        <circle cx="12" cy="12" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2" className="text-divider" />
        <circle
          cx="12"
          cy="12"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={isLow ? "text-danger" : "text-link"}
          transform="rotate(-90 12 12)"
          style={{ transition: "stroke-dashoffset 1s linear" }}
        />
      </svg>
      <span className={cx("text-label tabular-nums", isLow ? "text-danger" : "text-ink-muted")}>{remaining}s</span>
    </div>
  );
}
