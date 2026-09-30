import { Banner, type BannerAction, type BannerTone } from "../ui";

export type { BannerAction };

interface SyncBannerProps {
  tone: BannerTone;
  text: string;
  actions: readonly BannerAction[];
}

/** Full-width status strip above the main area (spec 3.8). The primary action stays a filled button (D-27). */
export default function SyncBanner({ tone, text, actions }: SyncBannerProps) {
  return (
    <Banner tone={tone} actions={actions} className="shrink-0">
      {text}
    </Banner>
  );
}
