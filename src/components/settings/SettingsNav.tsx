import { useState } from "react";
import {
  KeyboardIcon, PaletteIcon, RobotIcon, FloppyIcon, UsersIcon, UserIcon,
  TerminalIcon, DesktopIcon, EyeIcon, GlobeIcon, ChevronRightIcon, ChevronDownIcon,
  ShieldCheckIcon, KeyIcon, FingerprintIcon, DeviceMobileIcon,
} from "../../lib/icons";
import type { IconComponent } from "../../lib/icons";
import type { SettingsTab } from "./SettingsHelpers";

type TablerIcon = IconComponent;

type NavItem =
  | { kind: "item"; id: SettingsTab; icon: TablerIcon; label: string }
  | { kind: "group"; id: string; icon: TablerIcon; label: string; children: { kind: "item"; id: SettingsTab; icon: TablerIcon; label: string }[] };

const NAV_ITEMS: NavItem[] = [
  { kind: "item", id: "general", icon: KeyboardIcon, label: "General" },
  { kind: "item", id: "appearance", icon: PaletteIcon, label: "Appearance" },
  { kind: "item", id: "security", icon: FingerprintIcon, label: "Security" },
  {
    kind: "group",
    id: "sessions",
    icon: TerminalIcon,
    label: "Sessions",
    children: [
      { kind: "item", id: "sessions/terminal", icon: TerminalIcon, label: "Terminal" },
      { kind: "item", id: "sessions/ssh", icon: KeyIcon, label: "SSH" },
      { kind: "item", id: "sessions/rdp", icon: DesktopIcon, label: "RDP" },
      { kind: "item", id: "sessions/vnc", icon: EyeIcon, label: "VNC" },
      { kind: "item", id: "sessions/web", icon: GlobeIcon, label: "Web" },
    ],
  },
  {
    kind: "group",
    id: "ai",
    icon: RobotIcon,
    label: "AI",
    children: [
      { kind: "item", id: "ai/agent", icon: RobotIcon, label: "Agent" },
      { kind: "item", id: "ai/tools", icon: ShieldCheckIcon, label: "Tool Approvals" },
    ],
  },
  { kind: "item", id: "backup", icon: FloppyIcon, label: "Backup" },
  { kind: "item", id: "mobile", icon: DeviceMobileIcon, label: "Mobile" },
  { kind: "item", id: "team", icon: UsersIcon, label: "Team" },
  { kind: "item", id: "account", icon: UserIcon, label: "Account" },
];

interface SettingsNavProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
}

export default function SettingsNav({ activeTab, onTabChange }: SettingsNavProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ sessions: false });

  const toggleGroup = (groupId: string) => {
    setExpanded((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const renderItem = (id: SettingsTab, Icon: TablerIcon, label: string, indent = false) => (
    <button
      key={id}
      onClick={() => onTabChange(id)}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm ${
        indent ? "pl-8" : ""
      } ${
        activeTab === id
          ? "bg-conduit-600/20 text-conduit-400"
          : "hover:bg-raised"
      }`}
    >
      <Icon size={16} />
      <span>{label}</span>
    </button>
  );

  return (
    <div className="w-52 border-r border-stroke p-2 overflow-y-auto">
      {NAV_ITEMS.map((item) => {
        if (item.kind === "item") {
          return renderItem(item.id, item.icon, item.label);
        }

        const isExpanded = expanded[item.id] ?? false;
        const isGroupActive = activeTab.startsWith(`${item.id}/`);
        const ChevronIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;

        return (
          <div key={item.id}>
            <button
              onClick={() => toggleGroup(item.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm ${
                isGroupActive && !isExpanded ? "bg-conduit-600/20 text-conduit-400" : "hover:bg-raised"
              }`}
            >
              <item.icon size={16} />
              <span className="flex-1 text-left">{item.label}</span>
              <ChevronIcon size={14} className="text-ink-faint" />
            </button>
            {isExpanded && (
              <div className="mt-0.5 space-y-0.5">
                {item.children.map((child) =>
                  renderItem(child.id, child.icon, child.label, true)
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
