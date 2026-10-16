import type { PopupMenuItem } from "../../utils/contextMenu";
import type { EntryType } from "../../types/entry";
import type { CredentialType } from "../../types/credential";
import { ENTRY_TYPE_CATEGORIES, type TypeOption } from "./EntryTypeStep";

/** What a create item in a popup menu asks for, once the menu returns its id. */
export type CreateAction =
  | { kind: "entry"; type: EntryType; credentialType?: CredentialType }
  | { kind: "pickType" }
  | { kind: "folder" };

/** The detail of a "conduit:new-entry" event. Without `type` the dialog opens on the type picker. */
export interface NewEntryRequest {
  folderId?: string | null;
  type?: EntryType;
  credentialType?: CredentialType;
}

const ENTRY_ID_PREFIX = "new_entry:";
const PICK_TYPE_ID = "new_entry:pick";
const NEW_FOLDER_ID = "new_folder";

const SEPARATOR = (id: string): PopupMenuItem => ({ id, label: "", type: "separator" });

const entryItemId = (option: TypeOption) =>
  `${ENTRY_ID_PREFIX}${option.type}${option.credentialType ? `:${option.credentialType}` : ""}`;

const ALL_OPTIONS: readonly TypeOption[] = ENTRY_TYPE_CATEGORIES.flatMap((c) => c.items);

const NEW_FOLDER_ITEM: PopupMenuItem = { id: NEW_FOLDER_ID, label: "New Folder", icon: "folderPlus" };

export const newFolderItem = (): PopupMenuItem => ({ ...NEW_FOLDER_ITEM });

const VIEW_ONLY_MENU: readonly PopupMenuItem[] = [{ id: "view_only", label: "View-only access", type: "header" }];

/** Every entry type, grouped as on the type picker. */
function entryTypeItems(): PopupMenuItem[] {
  return ENTRY_TYPE_CATEGORIES.flatMap((category, index) => [
    ...(index > 0 ? [SEPARATOR(`sep_type_${index}`)] : []),
    ...category.items.map((option) => ({ id: entryItemId(option), label: option.label, icon: option.iconName })),
  ]);
}

export function newEntrySubmenu(): PopupMenuItem {
  return { id: "new_entry", label: "New Entry", icon: "plus", children: entryTypeItems() };
}

/** The entry types plus New Folder, for creating next to an entry. */
export function newHereSubmenu(label: string): PopupMenuItem {
  return { id: "new_here", label, icon: "plus", children: [...entryTypeItems(), SEPARATOR("sep_here_folder"), NEW_FOLDER_ITEM] };
}

/** Right-click on the tree's blank space. */
export function blankAreaMenu(canCreate: boolean): PopupMenuItem[] {
  return canCreate ? [newEntrySubmenu(), NEW_FOLDER_ITEM] : [...VIEW_ONLY_MENU];
}

/** The sidebar header's + dropdown: one click to any type. */
export function headerCreateMenu(): PopupMenuItem[] {
  return [
    ...entryTypeItems(),
    SEPARATOR("sep_header_more"),
    { id: PICK_TYPE_ID, label: "Choose Type…", icon: "plus" },
    NEW_FOLDER_ITEM,
  ];
}

export function parseCreateAction(id: string | null): CreateAction | null {
  if (id === NEW_FOLDER_ID) return { kind: "folder" };
  if (id === PICK_TYPE_ID) return { kind: "pickType" };
  const option = id ? ALL_OPTIONS.find((o) => entryItemId(o) === id) : undefined;
  if (!option) return null;
  return option.credentialType
    ? { kind: "entry", type: option.type, credentialType: option.credentialType }
    : { kind: "entry", type: option.type };
}

export function runCreateAction(action: CreateAction, folderId: string | null): void {
  if (action.kind === "folder") {
    document.dispatchEvent(new CustomEvent("conduit:new-folder", { detail: { parentId: folderId } }));
    return;
  }
  const detail: NewEntryRequest =
    action.kind === "pickType"
      ? { folderId }
      : { folderId, type: action.type, ...(action.credentialType ? { credentialType: action.credentialType } : {}) };
  document.dispatchEvent(new CustomEvent("conduit:new-entry", { detail }));
}

/** Reads a "conduit:new-entry" detail, keeping only a folder id string and types the picker offers. */
export function readNewEntryRequest(detail: unknown): NewEntryRequest & { folderId: string | null } {
  const raw = typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : {};
  const folderId = typeof raw.folderId === "string" ? raw.folderId : null;
  const option = ALL_OPTIONS.find((o) => o.type === raw.type);
  if (!option) return { folderId };
  const credential = option.type === "credential" ? ALL_OPTIONS.find((o) => o.credentialType && o.credentialType === raw.credentialType) : undefined;
  return credential?.credentialType
    ? { folderId, type: option.type, credentialType: credential.credentialType }
    : { folderId, type: option.type };
}
