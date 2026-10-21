import type { EntryMeta, FolderData } from "../../../types/entry";
import { ENTRY_KIND_LABELS, entryKindOf, getEntryColor, getEntryIcon, type EntryKind } from "../../entries/entryIcons";

export { entryTypeLabel } from "../../entries/entryIcons";
import { useEntryStore } from "../../../stores/entryStore";
import { useTierStore } from "../../../stores/tierStore";
import { openDashboardForEntry } from "../../../lib/openDashboard";
import { IconButton } from "../../ui";
import { copyPassword } from "./copyPassword";

export const TYPE_LABELS: Readonly<Record<EntryKind | "folder", string>> = { ...ENTRY_KIND_LABELS, folder: "Folder" };

export function EntryIcon({ entry }: { entry: Pick<EntryMeta, "entry_type" | "icon" | "color"> & { credential_type?: string | null } }) {
  const kind = entryKindOf(entry);
  const Icon = getEntryIcon(kind, false, entry.icon);
  const color = getEntryColor(kind, entry.color);
  return <Icon size={16} className={color.className} style={color.style} />;
}

export function FolderIcon({ folder }: { folder: Pick<FolderData, "icon" | "color"> }) {
  const Icon = getEntryIcon("folder", false, folder.icon);
  const color = getEntryColor("folder", folder.color);
  return <Icon size={16} className={color.className} style={color.style} />;
}

/** Entries that count toward the plan's connection limit (everything but credentials and documents). */
export function countConnections(entries: readonly EntryMeta[]): number {
  return entries.filter((e) => e.entry_type !== "credential" && e.entry_type !== "document").length;
}

/** The Home open rule: a credential shows its info tab, anything else goes to its open tab or opens (locked entries toast in openEntry). */
export function openHomeEntry(entry: Pick<EntryMeta, "id" | "entry_type">): void {
  if (entry.entry_type === "credential") {
    openDashboardForEntry(entry.id);
    return;
  }
  void useEntryStore.getState().openOrFocusEntry(entry.id);
}

/** Copy password (not for entries the plan locks) and View info, the trailing actions of Home entry rows. */
export function EntryRowActions({ entryId }: { entryId: string }) {
  const locked = useTierStore((s) => s.lockedEntryIds.has(entryId));
  return (
    <>
      {!locked && <IconButton size="sm" icon="key" label="Copy password" onClick={() => void copyPassword(entryId)} />}
      <IconButton size="sm" icon="infoCircle" label="View info" onClick={() => openDashboardForEntry(entryId)} />
    </>
  );
}
