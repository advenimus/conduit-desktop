import type { EntryType } from "../../types/entry";
import {
  DesktopIcon, DevicesIcon, InfoCircleIcon, KeyIcon, PlayerPlayIcon, RobotIcon, SettingsIcon, ShieldLockIcon
} from "../../lib/icons";
import type { IconComponent } from "../../lib/icons";

export type EntryTabId = "general" | "credentials" | "display" | "resources" | "security" | "autofill" | "command" | "information";

export interface EntryTab {
  id: EntryTabId;
  label: string;
  icon: IconComponent;
}

export interface EntryTabCategory {
  label: string;
  tabs: EntryTab[];
}

export function getTabCategories(entryType: EntryType): EntryTabCategory[] {
  const categories: EntryTabCategory[] = [];

  // Common category
  const commonTabs: EntryTab[] = [
    { id: "general", label: "General", icon: SettingsIcon },
  ];

  if (entryType !== "document") {
    commonTabs.push({ id: "credentials", label: "Credentials", icon: KeyIcon });
  }

  commonTabs.push({ id: "information", label: "Information", icon: InfoCircleIcon });
  categories.push({ label: "Common", tabs: commonTabs });

  // Connection category
  if (entryType === "rdp") {
    categories.push({
      label: "Connection",
      tabs: [
        { id: "display", label: "Display", icon: DesktopIcon },
        { id: "resources", label: "Resources", icon: DevicesIcon },
        { id: "security", label: "Security", icon: ShieldLockIcon },
      ],
    });
  } else if (entryType === "web") {
    categories.push({
      label: "Connection",
      tabs: [
        { id: "autofill", label: "Autofill", icon: RobotIcon },
        { id: "security", label: "Security", icon: ShieldLockIcon },
      ],
    });
  } else if (entryType === "command") {
    categories.push({
      label: "Execution",
      tabs: [
        { id: "command", label: "Command", icon: PlayerPlayIcon },
      ],
    });
  }

  return categories;
}

export function getDefaultTabId(): EntryTabId {
  return "general";
}
