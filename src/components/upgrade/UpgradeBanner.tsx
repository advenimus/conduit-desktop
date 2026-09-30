import { Button, Callout } from "../ui";

interface UpgradeBannerProps {
  message: string;
  ctaLabel: string;
  onCta: () => void;
  onDismiss?: () => void;
}

export default function UpgradeBanner({ message, ctaLabel, onCta, onDismiss }: UpgradeBannerProps) {
  return (
    <Callout tone="info" icon="bolt" size="sm" onDismiss={onDismiss}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-ink-muted">{message}</span>
        <Button variant="link" onClick={onCta} className="font-medium">
          {ctaLabel} &rarr;
        </Button>
      </div>
    </Callout>
  );
}
