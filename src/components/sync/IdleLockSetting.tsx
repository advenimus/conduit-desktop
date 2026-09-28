import { ClockIcon } from "../../lib/icons";

interface IdleLockOption {
  readonly minutes: number;
  readonly label: string;
}

export const IDLE_LOCK_OPTIONS: readonly IdleLockOption[] = [
  { minutes: 0, label: "Off" },
  { minutes: 5, label: "After 5 minutes" },
  { minutes: 15, label: "After 15 minutes" },
  { minutes: 30, label: "After 30 minutes" },
  { minutes: 60, label: "After 1 hour" },
];

/** What the main process honors: any positive whole number of minutes; anything else is Off. */
export function normalizeIdleMinutes(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

/** The menu, plus "Custom (N min)" in order for a stored value it does not list, so it shows and saves as is. */
export function idleLockOptions(minutes: number): readonly IdleLockOption[] {
  if (IDLE_LOCK_OPTIONS.some((o) => o.minutes === minutes)) return IDLE_LOCK_OPTIONS;
  return [...IDLE_LOCK_OPTIONS, { minutes, label: `Custom (${minutes} min)` }].sort((a, b) => a.minutes - b.minutes);
}

interface IdleLockSettingProps {
  minutes: unknown;
  onChange: (minutes: number) => void;
}

/** "Lock the vault when idle" (off by default); saved with the Settings dialog. */
export default function IdleLockSetting({ minutes, onChange }: IdleLockSettingProps) {
  const value = normalizeIdleMinutes(minutes);
  return (
    <div className="flex items-center justify-between p-3 rounded-lg bg-well border border-stroke-dim">
      <div className="flex items-center gap-3">
        <ClockIcon size={20} className={value > 0 ? "text-conduit-400" : "text-ink-faint"} />
        <div>
          <p className="text-sm font-medium text-ink">Lock the vault when idle</p>
          <p className="text-xs text-ink-muted mt-0.5">Locks when this computer is idle or its screen locks. Open connections close.</p>
        </div>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Lock the vault when idle"
        className="px-2 py-1.5 bg-panel border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
      >
        {idleLockOptions(value).map((o) => (
          <option key={o.minutes} value={o.minutes}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
