import type { IconComponent } from "../../lib/icons";
import {
  TerminalIcon,
  DesktopIcon,
  ServerAltIcon,
  GlobeIcon,
  KeyIcon,
  FileTextIcon,
  PlayerPlayIcon,
  FolderIcon,
  FolderOpenIcon,
  NetworkIcon,
} from "../../lib/icons";
import type { EntryType } from "../../types/entry";
import { isRdGateway, RD_GATEWAY_CREDENTIAL_TYPE } from "../../lib/rdpGateway";
import { resolveIcon } from "./iconRegistry";

/** What the UI shows an entry as: its type, except that an RD Gateway (a credential underneath) is its own kind. */
export type EntryKind = EntryType | "rd_gateway";

export function entryKindOf(entry: { entry_type: EntryType; credential_type?: string | null }): EntryKind {
  return isRdGateway(entry) ? "rd_gateway" : entry.entry_type;
}

export const ENTRY_KIND_LABELS: Readonly<Record<EntryKind, string>> = {
  ssh: "SSH",
  rdp: "RDP",
  vnc: "VNC",
  web: "Web",
  command: "Command",
  document: "Document",
  credential: "Credential",
  rd_gateway: "RD Gateway",
};

export function entryTypeLabel(entry: { entry_type: EntryType; credential_type?: string | null }): string {
  return ENTRY_KIND_LABELS[entryKindOf(entry)];
}

export function getEntryIcon(
  entryType: EntryKind | "folder",
  isOpen?: boolean,
  customIcon?: string | null,
  credentialType?: string | null,
): IconComponent {
  if (customIcon) {
    const resolved = resolveIcon(customIcon);
    if (resolved) return resolved;
  }
  if (entryType === "credential" && credentialType === RD_GATEWAY_CREDENTIAL_TYPE) return NetworkIcon;

  switch (entryType) {
    case "rd_gateway":
      return NetworkIcon;
    case "ssh":
      return TerminalIcon;
    case "rdp":
      return DesktopIcon;
    case "vnc":
      return ServerAltIcon;
    case "web":
      return GlobeIcon;
    case "credential":
      return KeyIcon;
    case "document":
      return FileTextIcon;
    case "command":
      return PlayerPlayIcon;
    case "folder":
      return isOpen ? FolderOpenIcon : FolderIcon;
    default:
      return ServerAltIcon;
  }
}

export interface EntryColorResult {
  className?: string;
  style?: React.CSSProperties;
}

export function getEntryColor(
  entryType: EntryKind | "folder",
  customColor?: string | null,
  credentialType?: string | null,
): EntryColorResult {
  if (customColor) {
    return { style: { color: customColor } };
  }
  if (entryType === "credential" && credentialType === RD_GATEWAY_CREDENTIAL_TYPE) return { className: "text-entry-rdp" };

  switch (entryType) {
    case "rd_gateway":
      return { className: "text-entry-rdp" };
    case "ssh":
      return { className: "text-entry-ssh" };
    case "rdp":
      return { className: "text-entry-rdp" };
    case "vnc":
      return { className: "text-entry-vnc" };
    case "web":
      return { className: "text-entry-web" };
    case "credential":
      return { className: "text-entry-credential" };
    case "document":
      return { className: "text-entry-document" };
    case "command":
      return { className: "text-entry-command" };
    case "folder":
      return { className: "text-entry-folder" };
    default:
      return { className: "text-ink-muted" };
  }
}
