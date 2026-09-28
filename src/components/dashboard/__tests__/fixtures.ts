import type { EntryMeta, FolderData } from "../../../types/entry";

const MINUTE = 60_000;

export function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * MINUTE).toISOString();
}

export function entry(overrides: Partial<EntryMeta> & Pick<EntryMeta, "id" | "name" | "entry_type">): EntryMeta {
  return {
    folder_id: null,
    parent_entry_id: null,
    sort_order: 0,
    host: null,
    port: null,
    credential_id: null,
    username: null,
    domain: null,
    icon: null,
    color: null,
    config: {},
    tags: [],
    is_favorite: false,
    notes: null,
    credential_type: null,
    created_at: minutesAgo(60 * 24 * 3),
    updated_at: minutesAgo(13),
    ...overrides,
  };
}

export function folder(overrides: Partial<FolderData> & Pick<FolderData, "id" | "name">): FolderData {
  return { parent_id: null, sort_order: 0, icon: null, color: null, created_at: minutesAgo(60), updated_at: minutesAgo(60), ...overrides };
}

/** The label and meta of a ListRow button, read from its markup. */
export function rowParts(row: HTMLElement): { label: string; meta: string | null } {
  const label = row.querySelector(".truncate")?.textContent ?? "";
  const meta = row.querySelector(".text-meta.text-ink-faint")?.textContent ?? null;
  return { label, meta };
}
