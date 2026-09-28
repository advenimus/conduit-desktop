import type { AcquireFreeze } from "./registry";

export const LEGACY_FREEZE_EVENTS = [
  "conduit:overlay-change",
  "conduit:sidebar-overlay-change",
  "conduit:drag-change",
] as const;

/** Maps each legacy boolean event to at most one "legacy" holder. Returns an uninstall function. */
export function installLegacyBridge(target: EventTarget, acquire: AcquireFreeze): () => void {
  let releases: ReadonlyMap<string, () => void> = new Map();

  const onEvent = (event: Event) => {
    const active = Boolean((event as CustomEvent).detail);
    const release = releases.get(event.type);
    if (active && !release) {
      releases = new Map(releases).set(event.type, acquire("legacy", event.type));
    } else if (!active && release) {
      const next = new Map(releases);
      next.delete(event.type);
      releases = next;
      release();
    }
  };

  for (const type of LEGACY_FREEZE_EVENTS) target.addEventListener(type, onEvent);

  return () => {
    for (const type of LEGACY_FREEZE_EVENTS) target.removeEventListener(type, onEvent);
    const held = releases;
    releases = new Map();
    held.forEach((release) => release());
  };
}
