import {
  KeyboardIcon, PaletteIcon, RobotIcon, FloppyIcon, UsersIcon, UserIcon,
  TerminalIcon, DesktopIcon, EyeIcon, GlobeIcon,
  KeyIcon, FingerprintIcon, DeviceMobileIcon, DevicesIcon,
} from "../../lib/icons";
import { NavList, type NavEntry } from "../ui";
import type { SettingsTab } from "./SettingsHelpers";

export const SETTINGS_NAV: ReadonlyArray<NavEntry> = [
  { id: "general", icon: KeyboardIcon, label: "General" },
  { id: "appearance", icon: PaletteIcon, label: "Appearance" },
  { id: "security", icon: FingerprintIcon, label: "Security" },
  {
    kind: "group",
    id: "sessions",
    icon: TerminalIcon,
    label: "Sessions",
    children: [
      { id: "sessions/terminal", icon: TerminalIcon, label: "Terminal" },
      { id: "sessions/ssh", icon: KeyIcon, label: "SSH" },
      { id: "sessions/rdp", icon: DesktopIcon, label: "RDP" },
      { id: "sessions/vnc", icon: EyeIcon, label: "VNC" },
      { id: "sessions/web", icon: GlobeIcon, label: "Web" },
    ],
  },
  { id: "ai/agent", icon: RobotIcon, label: "AI" },
  { id: "backup", icon: FloppyIcon, label: "Backup" },
  { id: "sync", icon: DevicesIcon, label: "Sync" },
  { id: "mobile", icon: DeviceMobileIcon, label: "Mobile" },
  { id: "team", icon: UsersIcon, label: "Team" },
  { id: "account", icon: UserIcon, label: "Account" },
];

interface SettingsNavProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
}

/** The harness finds the nav by `data-cv-settings-nav` (B2) and, until wave 4, by `w-52`. */
export default function SettingsNav({ activeTab, onTabChange }: SettingsNavProps) {
  return (
    <NavList
      data-cv-settings-nav=""
      items={SETTINGS_NAV}
      value={activeTab}
      onChange={(id) => onTabChange(id as SettingsTab)}
      className="w-52 shrink-0 overflow-y-auto border-r border-divider p-2"
    />
  );
}
