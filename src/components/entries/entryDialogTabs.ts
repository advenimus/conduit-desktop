import type { EntryType } from "../../types/entry";
import { RD_GATEWAY_CREDENTIAL_TYPE } from "../../lib/rdpGateway";
import {
  DesktopIcon, DevicesIcon, InfoCircleIcon, KeyIcon, NetworkIcon, PlayerPlayIcon, RobotIcon, SettingsIcon, ShieldLockIcon, UserIcon
} from "../../lib/icons";
import type { IconComponent } from "../../lib/icons";

export type EntryTabId =
  | "general"
  | "credentials"
  | "display"
  | "resources"
  | "security"
  | "gateway"
  | "gateway_server"
  | "gateway_login"
  | "autofill"
  | "command"
  | "information";

export interface EntryTab {
  id: EntryTabId;
  label: string;
  icon: IconComponent;
}

export interface EntryTabCategory {
  label: string;
  tabs: EntryTab[];
}

export function getTabCategories(entryType: EntryType, credentialType?: string | null): EntryTabCategory[] {
  const categories: EntryTabCategory[] = [];

  if (entryType === "credential" && credentialType === RD_GATEWAY_CREDENTIAL_TYPE) {
    return [
      {
        label: "Common",
        tabs: [
          { id: "general", label: "General", icon: SettingsIcon },
          { id: "information", label: "Information", icon: InfoCircleIcon },
        ],
      },
      {
        label: "Gateway",
        tabs: [
          { id: "gateway_server", label: "Server", icon: NetworkIcon },
          { id: "gateway_login", label: "Login", icon: UserIcon },
        ],
      },
    ];
  }

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
        { id: "gateway", label: "Gateway", icon: NetworkIcon },
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
