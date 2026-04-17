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
    if (resolved) return resolved as unknown as IconComponent;
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
      return { className: "text-green-400" };
    case "rdp":
      return { className: "text-blue-400" };
    case "vnc":
      return { className: "text-purple-400" };
    case "web":
      return { className: "text-cyan-400" };
    case "credential":
      return { className: "text-yellow-400" };
    case "document":
      return { className: "text-teal-400" };
    case "command":
      return { className: "text-amber-400" };
    case "folder":
      return { className: "text-ink-muted" };
    default:
      return { className: "text-ink-muted" };
  }
}
