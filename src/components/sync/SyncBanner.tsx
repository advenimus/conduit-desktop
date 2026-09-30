import { AlertTriangleIcon, InfoCircleIcon, LockIcon } from "../../lib/icons";

export interface BannerAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly primary?: boolean;
  readonly disabled?: boolean;
}

type BannerTone = "info" | "warn" | "lock";

const TONES: Readonly<Record<BannerTone, string>> = {
  info: "bg-conduit-600/10 border-conduit-600/20 text-ink-secondary",
  warn: "bg-amber-600/15 border-amber-600/30 text-ink-secondary",
  lock: "bg-raised border-stroke text-ink-secondary",
};

const ICONS = { info: InfoCircleIcon, warn: AlertTriangleIcon, lock: LockIcon } as const;

interface SyncBannerProps {
  tone: BannerTone;
  text: string;
  actions: readonly BannerAction[];
}

/** Full-width status strip above the main area, like the offline banner. */
export default function SyncBanner({ tone, text, actions }: SyncBannerProps) {
  const Icon = ICONS[tone];
  return (
    <div className={`flex items-center gap-2 px-4 py-1.5 border-b text-xs flex-shrink-0 ${TONES[tone]}`} role="status">
      <Icon size={14} className={tone === "warn" ? "text-amber-400 flex-shrink-0" : "text-conduit-400 flex-shrink-0"} />
      <span className="flex-1 min-w-0">{text}</span>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={a.onClick}
          disabled={a.disabled}
          className={`px-2 py-0.5 rounded transition-colors whitespace-nowrap disabled:opacity-50 ${
            a.primary ? "bg-conduit-600 text-white hover:bg-conduit-500" : "bg-well hover:bg-raised text-ink"
          }`}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
