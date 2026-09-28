import { Card, IconSlot, Select } from "../ui";

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
    <Card className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <IconSlot icon="clock" size={20} className={value > 0 ? "text-link" : "text-ink-faint"} />
        <div>
          <p className="text-body font-semibold text-ink">Lock the vault when idle</p>
          <p className="mt-0.5 text-label text-ink-muted">Locks when this computer is idle or its screen locks. Open connections close.</p>
        </div>
      </div>
      <div className="w-40 shrink-0">
        <Select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label="Lock the vault when idle">
          {idleLockOptions(value).map((o) => (
            <option key={o.minutes} value={o.minutes}>{o.label}</option>
          ))}
        </Select>
      </div>
    </Card>
  );
}
