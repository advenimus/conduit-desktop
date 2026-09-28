import type { ReactNode } from "react";

/** A field label of the entry dashboard: title case, no CSS uppercase (spec 4.16). */
export function DetailLabel({ children }: { children: ReactNode }) {
  return <span className="block text-meta font-semibold text-ink-muted">{children}</span>;
}

export function DetailRow({
  label,
  value,
  icon,
  actions,
  last,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`py-3 flex items-center gap-3 ${last ? "" : "border-b border-divider"}`}>
      {icon && <div className="flex-shrink-0 text-ink-faint mt-0.5">{icon}</div>}
      <div className="flex-1 min-w-0">
        <DetailLabel>{label}</DetailLabel>
        <div className="text-body text-ink mt-0.5 allow-select">{value}</div>
      </div>
      {actions && <div className="flex-shrink-0">{actions}</div>}
    </div>
  );
}

export function TotpCountdown({ remaining, period }: { remaining: number; period: number }) {
  const size = 14;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = remaining / period;
  const dashOffset = circumference * (1 - fraction);
  const isLow = remaining <= 5;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="flex-shrink-0">
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke="currentColor" strokeWidth={strokeWidth}
        className="text-divider"
      />
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        className={`transition-all duration-1000 linear ${isLow ? "text-danger" : "text-link"}`}
        stroke="currentColor"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
