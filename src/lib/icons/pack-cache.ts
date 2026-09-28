import { mapping as codiconsMapping } from "./packs/codicons";
import type { IconMapping, IconPackId } from "./types";

type LazyIconPackId = Exclude<IconPackId, "codicons">;

// Each lazy pack is its own chunk, named after its module (lucide-*.js, ...).
const IMPORTERS: Readonly<Record<LazyIconPackId, () => Promise<{ mapping: IconMapping }>>> = {
  lucide: () => import("./packs/lucide"),
  tabler: () => import("./packs/tabler"),
  phosphor: () => import("./packs/phosphor"),
  fluent: () => import("./packs/fluent"),
  material: () => import("./packs/material"),
};

export const LAZY_ICON_PACKS: ReadonlyArray<LazyIconPackId> = Object.freeze(
  Object.keys(IMPORTERS) as LazyIconPackId[],
);

export const CODICONS_MAPPING: IconMapping = codiconsMapping;

const loaded = new Map<IconPackId, IconMapping>([["codicons", codiconsMapping]]);
const inFlight = new Map<IconPackId, Promise<IconMapping>>();
const listeners = new Set<(id: IconPackId) => void>();

export function getPackMapping(id: IconPackId): IconMapping | null {
  return loaded.get(id) ?? null;
}

export function loadedPackIds(): IconPackId[] {
  return [...loaded.keys()];
}

/** Calls `listener` whenever a lazy pack finishes loading. */
export function onPackLoaded(listener: (id: IconPackId) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Loads a pack once; concurrent callers share the same import. Rejects when the chunk fails to load. */
export function loadPack(id: IconPackId): Promise<IconMapping> {
  const cached = loaded.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(id);
  if (pending) return pending;

  const request = IMPORTERS[id as LazyIconPackId]()
    .then(({ mapping }) => {
      loaded.set(id, mapping);
      listeners.forEach((listener) => listener(id));
      return mapping;
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, request);
  return request;
}
