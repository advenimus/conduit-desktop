/**
 * Ref-counted freeze registry. Native web views paint over HTML, so every DOM
 * surface that can overlap the editor holds a freeze while it is open, and web
 * sessions show a screenshot instead of the live view while any freeze is held.
 */
import { useLayoutEffect, useSyncExternalStore } from "react";
import { createFreezeRegistry, type FreezeHolder, type FreezeReason } from "./registry";
import { installLegacyBridge } from "./legacy-bridge";
import { createLayoutNotifier } from "./layout";

export type { FreezeHolder, FreezeReason } from "./registry";

declare global {
  interface Window {
    __conduitFreeze?: () => ReadonlyArray<FreezeHolder>;
  }
}

const registry = createFreezeRegistry();

/** Returns an idempotent release function. */
export function acquireFreeze(reason: FreezeReason, label?: string): () => void {
  return registry.acquire(reason, label);
}

export function isFrozen(): boolean {
  return registry.isFrozen();
}

export function subscribe(listener: () => void): () => void {
  return registry.subscribe(listener);
}

export function freezeHolders(): ReadonlyArray<FreezeHolder> {
  return registry.holders();
}

export function useIsFrozen(): boolean {
  return useSyncExternalStore(subscribe, isFrozen, isFrozen);
}

export function useFreeze(active: boolean, reason: FreezeReason, label?: string): void {
  // Layout effect: the hold starts in the same commit that inserts the surface, before paint.
  useLayoutEffect(() => (active ? acquireFreeze(reason, label) : undefined), [active, reason, label]);
}

export const notifyLayoutChanged: () => void =
  typeof document === "undefined"
    ? () => {}
    : createLayoutNotifier(document, (callback) => window.requestAnimationFrame(callback));

if (typeof document !== "undefined") {
  installLegacyBridge(document, acquireFreeze);
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__conduitFreeze = freezeHolders;
}
