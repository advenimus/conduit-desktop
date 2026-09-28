import { useEffect, useState } from "react";
import { IconSlot } from "../ui";
import { syncApi } from "../../lib/sync-api";
import type { SyncDeviceInfo } from "../../types/sync";
import { busyText, formatAgo, providerPlace } from "./sync-copy";

function isMobile(platform: string): boolean {
  return /ios|iphone|ipad/i.test(platform);
}

function deviceLine(d: SyncDeviceInfo): string {
  const parts: string[] = [];
  const open = d.server ? d.server.status === "active" : d.sessionOpen;
  parts.push(open ? "Open now" : "Closed");
  const last = d.server?.lastActiveMs ?? d.lastActiveMs;
  if (last) parts.push(`active ${formatAgo(last)}`);
  if (d.fileHint) parts.push(`syncs ${providerPlace(d.fileHint.location)}`);
  const busy = d.server ? busyText(d.server.busySessions, d.server.busyJobs) : null;
  if (busy) parts.push(busy);
  if (d.server?.pendingChanges) parts.push("has changes not synced yet");
  return parts.join(" · ");
}

/** Devices that opened this vault (presence plus the server's sessions when signed in). */
export default function SyncDevicesList() {
  const [devices, setDevices] = useState<readonly SyncDeviceInfo[] | null>(null);
  useEffect(() => {
    syncApi.listDevices().then(setDevices).catch((err) => {
      console.error("[sync] Failed to list devices:", err);
      setDevices([]);
    });
  }, []);
  if (devices === null || devices.length === 0) return null;
  return (
    <div className="divide-y divide-stroke-dim rounded-md border border-stroke-dim">
      {devices.map((d) => {
        return (
          <div key={d.deviceUuid} data-cv-device-row="" className="flex items-center gap-3 px-3 py-2">
            <IconSlot icon={isMobile(d.platform) ? "deviceMobile" : "desktop"} className="shrink-0 text-ink-muted" />
            <div className="min-w-0">
              <p data-cv-device-name="" className="truncate text-body text-ink">
                {d.name}
                {d.thisDevice && <span className="text-label text-ink-muted"> (this device)</span>}
              </p>
              <p data-cv-device-line="" className="truncate text-label text-ink-muted">{deviceLine(d)}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
