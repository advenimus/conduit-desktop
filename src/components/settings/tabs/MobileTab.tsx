import { DeviceMobileIcon } from "../../../lib/icons";
import { SectionHeader } from "../../ui";
import { HINT } from "../settings-styles";

/** Apple logo SVG. */
function AppleIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-label="Apple"
    >
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

/**
 * Pre-generated QR code for the App Store listing (app id 6760924705).
 * Uses currentColor stroke so it adapts to light/dark themes.
 */
function AppStoreQrCode({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 31 31"
      shapeRendering="crispEdges"
      aria-label="QR code to download Conduit on the App Store"
    >
      <path fill="none" d="M0 0h31v31H0z" />
      <path
        stroke="currentColor"
        d="M1 1.5h7m2 0h1m1 0h1m3 0h5m2 0h7M1 2.5h1m5 0h1m2 0h1m1 0h2m4 0h1m2 0h1m1 0h1m5 0h1M1 3.5h1m1 0h3m1 0h1m1 0h4m2 0h1m1 0h1m3 0h1m1 0h1m1 0h3m1 0h1M1 4.5h1m1 0h3m1 0h1m1 0h2m2 0h1m4 0h1m1 0h1m2 0h1m1 0h3m1 0h1M1 5.5h1m1 0h3m1 0h1m1 0h2m1 0h1m1 0h3m2 0h3m1 0h1m1 0h3m1 0h1M1 6.5h1m5 0h1m1 0h1m1 0h7m1 0h1m1 0h1m1 0h1m5 0h1M1 7.5h7m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h7M9 8.5h1m3 0h2m1 0h2m2 0h2M1 9.5h1m1 0h5m4 0h1m2 0h2m1 0h1m1 0h1m2 0h5M1 10.5h1m1 0h1m2 0h1m1 0h1m2 0h3m3 0h1m2 0h4m1 0h1m3 0h1M6 11.5h2m1 0h1m1 0h3m2 0h2m1 0h1m1 0h1m1 0h2M3 12.5h2m5 0h2m3 0h3m1 0h2m1 0h2m1 0h2m1 0h1M1 13.5h1m1 0h1m1 0h1m1 0h1m2 0h3m4 0h2m5 0h1m1 0h2M4 14.5h3m1 0h5m1 0h3m3 0h6m3 0h1M1 15.5h1m3 0h3m1 0h2m3 0h4m1 0h1m2 0h1m2 0h3M2 16.5h1m5 0h1m1 0h1m3 0h1m2 0h1m1 0h3m3 0h1m2 0h1M2 17.5h3m1 0h4m1 0h2m2 0h6m3 0h1m1 0h2M1 18.5h1m2 0h1m1 0h1m2 0h2m1 0h2m2 0h1m1 0h3m2 0h3m1 0h1m1 0h1M1 19.5h1m1 0h3m1 0h1m3 0h1m1 0h1m2 0h1m1 0h1m2 0h2m2 0h1m1 0h1M1 20.5h1m4 0h1m8 0h3m3 0h2m2 0h1m2 0h1M1 21.5h1m1 0h3m1 0h1m1 0h1m1 0h1m4 0h1m1 0h1m2 0h5m1 0h3M9 22.5h1m1 0h2m1 0h2m2 0h2m1 0h1m3 0h5M1 23.5h7m2 0h1m2 0h3m3 0h3m1 0h1m1 0h3M1 24.5h1m5 0h1m1 0h1m3 0h2m5 0h2m3 0h1M1 25.5h1m1 0h3m1 0h1m1 0h1m2 0h2m1 0h1m2 0h1m2 0h5m1 0h1m1 0h1M1 26.5h1m1 0h3m1 0h1m1 0h1m1 0h4m4 0h1m4 0h1m1 0h2M1 27.5h1m1 0h3m1 0h1m1 0h1m1 0h1m2 0h1m1 0h1m3 0h2m1 0h6M1 28.5h1m5 0h1m3 0h1m2 0h1m1 0h1m2 0h1m1 0h2m1 0h3m1 0h1M1 29.5h7m1 0h4m1 0h1m1 0h2m1 0h2m1 0h1m2 0h1m1 0h1"
      />
    </svg>
  );
}

export default function MobileTab() {
  return (
    <div className="space-y-6">
      <SectionHeader title="Conduit Mobile" description="Access your vault on the go with Conduit for iOS and iPadOS." />

      {/* App Store card */}
      <div className="overflow-hidden rounded-md border border-card-border">
        <div className="flex items-center gap-5 bg-well p-5">
          <div className="shrink-0 rounded-md bg-white p-2">
            <AppStoreQrCode className="h-28 w-28 text-black" />
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-(--c-accent)">
                <DeviceMobileIcon size={20} className="text-white" />
              </div>
              <div>
                <p className="text-body font-semibold text-ink">Conduit</p>
                <p className={HINT}>iPhone & iPad</p>
              </div>
            </div>

            <p className={`leading-relaxed ${HINT}`}>
              Scan the QR code with your device camera to download from the App Store.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2.5 border-t border-card-border px-4 py-3">
          <AppleIcon size={16} className="mt-0.5 shrink-0 text-ink-muted" />
          <p className={`leading-relaxed ${HINT}`}>
            Keep your vault file in iCloud Drive, OneDrive, or Dropbox to use it on all your devices. Conduit merges the changes from each one. On the Free plan a vault can be open on one device at a time.
          </p>
        </div>
      </div>
    </div>
  );
}
