import { BoltIcon, CloseIcon } from "../../lib/icons";
interface UpgradeBannerProps {
  message: string;
  ctaLabel: string;
  onCta: () => void;
  onDismiss?: () => void;
}

export default function UpgradeBanner({ message, ctaLabel, onCta, onDismiss }: UpgradeBannerProps) {
  return (
    <div className="flex items-center gap-2 bg-conduit-500/5 border border-conduit-500/20 rounded-lg px-3 py-2">
      <BoltIcon size={14} className="text-conduit-400 flex-shrink-0" />
      <span className="text-xs text-ink-muted flex-1 truncate">{message}</span>
      <button
        onClick={onCta}
        className="text-conduit-400 hover:text-conduit-300 font-medium text-xs whitespace-nowrap"
      >
        {ctaLabel} &rarr;
      </button>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="text-ink-faint hover:text-ink-muted p-0.5"
        >
          <CloseIcon size={12} />
        </button>
      )}
    </div>
  );
}
