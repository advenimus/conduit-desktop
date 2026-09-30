import type { EntryType } from "../../types/entry";
import type { CredentialType } from "../../types/credential";
import type { EntryTabId } from "./entryDialogTabs";
import { getTabCategories } from "./entryDialogTabs";
import { getEntryIcon, getEntryColor } from "./entryIcons";
import { ShieldLockIcon } from "../../lib/icons";
import { NavList, type NavEntry } from "../ui";

interface EntryDialogSidebarProps {
  entryType: EntryType;
  activeTab: EntryTabId;
  onTabChange: (tab: EntryTabId) => void;
  credentialType?: CredentialType | null;
}

const TYPE_LABELS: Record<EntryType, string> = {
  ssh: "SSH Session",
  rdp: "RDP Session",
  vnc: "VNC Session",
  web: "Web Session",
  credential: "Credential",
  document: "Document",
  command: "Command",
};

export default function EntryDialogSidebar({ entryType, activeTab, onTabChange, credentialType }: EntryDialogSidebarProps) {
  const isSshKey = entryType === "credential" && credentialType === "ssh_key";
  const TypeIcon = isSshKey ? ShieldLockIcon : getEntryIcon(entryType, false);
  const colorResult = isSshKey ? { className: "text-entry-sshkey", style: undefined } : getEntryColor(entryType);
  const label = isSshKey ? "SSH Key" : TYPE_LABELS[entryType];
  const items: NavEntry[] = getTabCategories(entryType).flatMap((category) => [
    { kind: "label" as const, id: `label-${category.label}`, label: category.label },
    ...category.tabs.map(({ id, label: tabLabel, icon }) => ({ id, label: tabLabel, icon })),
  ]);

  return (
    <div className="flex w-48 shrink-0 flex-col border-r border-divider">
      <div className="flex items-center gap-2 border-b border-divider px-3 py-3">
        <TypeIcon size={16} className={colorResult.className} style={colorResult.style} />
        <span className="text-body font-semibold text-ink">{label}</span>
      </div>
      <NavList
        items={items}
        value={activeTab}
        onChange={(id) => onTabChange(id as EntryTabId)}
        className="flex-1 overflow-y-auto p-2"
      />
    </div>
  );
}
