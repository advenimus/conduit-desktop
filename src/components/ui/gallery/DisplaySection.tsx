import { useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Callout,
  Card,
  CountBadge,
  EmptyState,
  Kbd,
  SectionHeader,
  SettingsRow,
  Spinner,
  Switch,
  ToastCard,
  type BadgeTone,
  type CalloutTone,
} from "..";
import { Demo, GallerySection } from "./Section";

const BADGE_TONES: ReadonlyArray<BadgeTone> = ["neutral", "accent", "warning", "danger", "success"];
const CALLOUT_TONES: ReadonlyArray<CalloutTone> = ["info", "warning", "danger", "success"];

function Badges() {
  return (
    <>
      <Demo label="Badge tones, CountBadge, Kbd">
        {BADGE_TONES.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
        <Badge tone="warning" icon="wifiOff">
          Offline
        </Badge>
        <CountBadge count={3} />
        <CountBadge count={42} />
        <CountBadge count={250} max={99} />
        <Kbd>Ctrl+P</Kbd>
        <Kbd>⌘,</Kbd>
      </Demo>
      <Demo label="Spinner 12, 16, 24, with text">
        <Spinner size={12} />
        <Spinner />
        <Spinner size={24} label="Loading" />
        <Spinner text="Looking for copies..." className="text-label text-ink-muted" />
      </Demo>
    </>
  );
}

function Notices() {
  return (
    <>
      <Demo label="Callout tones and sizes" className="grid max-w-[720px] grid-cols-2 items-start">
        {CALLOUT_TONES.map((tone) => (
          <Callout key={tone} tone={tone} title={`A ${tone} callout`} actions={tone === "warning" ? <Button size="sm">Review</Button> : undefined}>
            {tone === "danger" ? "That password did not work." : "Callouts explain something about the section they sit in."}
          </Callout>
        ))}
        <Callout tone="info" size="sm">
          A small callout without a title.
        </Callout>
      </Demo>
      <Demo label="Banner tones (26px, role=status, link actions)" className="block">
        <div className="flex max-w-[880px] flex-col bg-shell">
          <Banner tone="info" actions={[{ label: "Sync settings", onClick: () => {} }]}>
            This vault syncs to your other devices.
          </Banner>
          <Banner tone="warn" actions={[{ label: "Review changes", onClick: () => {} }, { label: "Later", onClick: () => {} }]}>
            3 changes from your other devices need review.
          </Banner>
          <Banner tone="lock" actions={[{ label: "Take over", onClick: () => {} }]}>
            This vault is open on another device. A long message wraps to a second line instead of being cut off, so no sync message is lost.
          </Banner>
        </div>
      </Demo>
      <Demo label="ToastCard types" className="grid max-w-[920px] grid-cols-2 items-start">
        <ToastCard type="success" title="Vault saved" message="Your changes are on every device." onClose={() => {}} />
        <ToastCard type="error" title="Could not connect" message="The host did not answer." actions={[{ id: "retry", label: "Try again", onClick: () => {}, variant: "primary" }]} onClose={() => {}} />
        <ToastCard type="warning" title="Offline" message="Working with cached features." onClose={() => {}} />
        <ToastCard type="info" title="Downloading update" progress={{ percent: 45, leftLabel: "45%", rightLabel: "12 MB of 27 MB" }} onClose={() => {}} />
      </Demo>
    </>
  );
}

function Containers() {
  const [local, setLocal] = useState(true);
  return (
    <Demo label="Card, SectionHeader, SettingsRow, EmptyState" className="grid max-w-[880px] grid-cols-2 items-start">
      <Card>
        <SectionHeader title="Multi-device sync" description="Keep this vault on every device you use." />
        <SettingsRow title="Local Backup" description="Keep copies of the vault on this device." toggle={<Switch checked={local} onChange={setLocal} data-cv-toggle="local" />} />
        <SettingsRow title="Keep backups for" description="Older backups are removed.">
          <span className="text-body text-ink-secondary">30 days</span>
        </SettingsRow>
      </Card>
      <Card>
        <EmptyState icon="folder" title="No entries yet" description="Add a connection to get started." action={<Button variant="primary" icon="plus">New Entry</Button>} />
      </Card>
    </Demo>
  );
}

export function DisplaySection() {
  return (
    <GallerySection id="display" title="Badge, Kbd, Spinner, Callout, Banner, containers, toasts">
      <Badges />
      <Notices />
      <Containers />
    </GallerySection>
  );
}
