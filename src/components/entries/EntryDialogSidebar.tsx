import type { EntryType } from "../../types/entry";
import type { CredentialType } from "../../types/credential";
import type { EntryTabId } from "./entryDialogTabs";
import { getTabCategories } from "./entryDialogTabs";
import { getEntryIcon, getEntryColor } from "./entryIcons";
import { ShieldLockIcon } from "../../lib/icons";

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
  const categories = getTabCategories(entryType);
  const isSshKey = entryType === "credential" && credentialType === "ssh_key";
  const TypeIcon = isSshKey ? ShieldLockIcon : getEntryIcon(entryType, false);
  const colorResult = isSshKey ? { className: "text-orange-400" } : getEntryColor(entryType);
  const label = isSshKey ? "SSH Key" : TYPE_LABELS[entryType];

  return (
    <div className="w-48 border-r border-stroke flex flex-col flex-shrink-0">
      {/* Entry type header */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-stroke">
        <TypeIcon size={18} className={colorResult.className} style={colorResult.style} />
        <span className="text-sm font-medium">{label}</span>
      </div>

      {/* Tab navigation */}
      <div className="p-2 flex-1">
        {categories.map((category, i) => (
          <div key={category.label} className={i > 0 ? "mt-3" : ""}>
            <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider px-3 mb-1">
              {category.label}
            </div>
            {category.tabs.map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => onTabChange(id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm ${
                  activeTab === id
                    ? "bg-conduit-600/20 text-conduit-400"
                    : "hover:bg-raised"
                }`}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
