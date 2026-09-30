import { mapping as lucideMapping } from "./packs/lucide";
import type { IconMapping, IconPackId } from "./types";

type LazyIconPackId = Exclude<IconPackId, "lucide">;

// Lucide is the default and ships in the entry chunk; each other pack is its own lazy chunk.
const IMPORTERS: Readonly<Record<LazyIconPackId, () => Promise<{ mapping: IconMapping }>>> = {
  phosphor: () => import("./packs/phosphor"),
  hugeicons: () => import("./packs/hugeicons"),
  material: () => import("./packs/material"),
  fluent: () => import("./packs/fluent"),
  tabler: () => import("./packs/tabler"),
};

export const LAZY_ICON_PACKS: ReadonlyArray<LazyIconPackId> = Object.freeze(
  Object.keys(IMPORTERS) as LazyIconPackId[],
);

export const LUCIDE_MAPPING: IconMapping = lucideMapping;

const loaded = new Map<IconPackId, IconMapping>([["lucide", lucideMapping]]);
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
