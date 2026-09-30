import type { EntryMeta, EntryType, FolderData } from "../../../types/entry";
import { getEntryColor, getEntryIcon } from "../../entries/entryIcons";
import { useEntryStore } from "../../../stores/entryStore";
import { openDashboardForEntry } from "../../../lib/openDashboard";

export const TYPE_LABELS: Readonly<Record<EntryType | "folder", string>> = {
  ssh: "SSH",
  rdp: "RDP",
  vnc: "VNC",
  web: "Web",
  command: "Command",
  document: "Document",
  credential: "Credential",
  folder: "Folder",
};

export function typeLabel(type: string): string {
  return TYPE_LABELS[type as EntryType] ?? type;
}

export function EntryIcon({ entry }: { entry: Pick<EntryMeta, "entry_type" | "icon" | "color"> }) {
  const Icon = getEntryIcon(entry.entry_type, false, entry.icon);
  const color = getEntryColor(entry.entry_type, entry.color);
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

/** The Home open rule: a credential shows its info tab, anything else opens (locked entries toast in openEntry). */
export function openHomeEntry(entry: Pick<EntryMeta, "id" | "entry_type">): void {
  if (entry.entry_type === "credential") {
    openDashboardForEntry(entry.id);
    return;
  }
  void useEntryStore.getState().openEntry(entry.id);
}
