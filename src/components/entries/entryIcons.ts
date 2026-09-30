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
} from "../../lib/icons";
import type { EntryType } from "../../types/entry";
import { resolveIcon } from "./iconRegistry";

export function getEntryIcon(
  entryType: EntryType | "folder",
  isOpen?: boolean,
  customIcon?: string | null,
): IconComponent {
  if (customIcon) {
    const resolved = resolveIcon(customIcon);
    if (resolved) return resolved;
  }

  switch (entryType) {
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
  entryType: EntryType | "folder",
  customColor?: string | null,
): EntryColorResult {
  if (customColor) {
    return { style: { color: customColor } };
  }

  switch (entryType) {
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
