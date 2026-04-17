import { CheckIcon, ExternalLinkIcon } from "../../lib/icons";
interface UpgradeGateProps {
  tier: "pro" | "team";
  title: string;
  features: string[];
  onUpgrade: () => void;
  onAccount: () => void;
  trialEligible?: boolean;
}

const TIER_INFO = {
  pro: { label: "Pro Plan", ctaLabel: "Upgrade to Pro", trialCtaLabel: "Start Free Trial" },
  team: { label: "Teams Plan", ctaLabel: "Upgrade to Teams", trialCtaLabel: "Start Free Trial" },
};

export default function UpgradeGate({ tier, title, features, onUpgrade, onAccount, trialEligible }: UpgradeGateProps) {
  const info = TIER_INFO[tier];

  return (
    <div className="flex h-full">
      {/* Left: Feature list */}
      <div className="flex-1 bg-well border-r border-stroke-dim px-5 py-6 flex flex-col justify-center">
        <h3 className="text-sm font-semibold text-ink mb-4">{title}</h3>
        <ul className="space-y-2.5">
          {features.map((feature) => (
            <li key={feature} className="flex items-center gap-2 text-sm text-ink-secondary">
              <CheckIcon size={14} className="text-conduit-400 flex-shrink-0" />
              {feature}
            </li>
          ))}
        </ul>
      </div>

      {/* Right: Upgrade CTA */}
      <div className="flex-1 px-5 py-6 flex flex-col items-center justify-center">
        <span className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-4">
          {info.label}
        </span>

        <button
          onClick={onUpgrade}
          className="w-full max-w-[200px] px-4 py-2.5 text-sm font-medium text-white bg-conduit-600 hover:bg-conduit-500 rounded-lg transition-colors text-center"
        >
          {trialEligible ? info.trialCtaLabel : info.ctaLabel} &rarr;
        </button>

        {trialEligible && (
          <p className="mt-2 text-[11px] text-ink-faint">No commitment. Cancel anytime.</p>
        )}

        <button
          onClick={onAccount}
          className="mt-3 inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink-secondary transition-colors"
        >
          <ExternalLinkIcon size={12} />
          Already subscribed? Sign in
        </button>
      </div>
    </div>
  );
}
