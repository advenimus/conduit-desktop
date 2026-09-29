import {
  TerminalIcon,
  DesktopIcon,
  ServerAltIcon,
  GlobeIcon,
  KeyIcon,
  ShieldLockIcon,
  FileTextIcon,
  PlayerPlayIcon,
} from "../../lib/icons";
import type { IconComponent } from "../../lib/icons";
import type { EntryType } from "../../types/entry";
import type { CredentialType } from "../../types/credential";
import { COLOR_TRANSITION, cx } from "../ui/cx";

export interface TypeOption {
  type: EntryType;
  label: string;
  description: string;
  icon: IconComponent;
  color: string;
  /** If set, triggers a special action instead of opening the normal entry form */
  credentialType?: CredentialType;
}

interface TypeCategory {
  label: string;
  items: TypeOption[];
}

const ENTRY_TYPE_CATEGORIES: TypeCategory[] = [
  {
    label: "Connections",
    items: [
      { type: "ssh", label: "SSH", description: "Terminal", icon: TerminalIcon, color: "text-entry-ssh" },
      { type: "rdp", label: "RDP", description: "Remote Desktop", icon: DesktopIcon, color: "text-entry-rdp" },
      { type: "vnc", label: "VNC", description: "Screen Share", icon: ServerAltIcon, color: "text-entry-vnc" },
      { type: "web", label: "Web", description: "Browser Session", icon: GlobeIcon, color: "text-entry-web" },
    ],
  },
  {
    label: "Documents",
    items: [{ type: "document", label: "Document", description: "Markdown", icon: FileTextIcon, color: "text-entry-document" }],
  },
  {
    label: "Automation",
    items: [{ type: "command", label: "Command", description: "Run As User", icon: PlayerPlayIcon, color: "text-entry-command" }],
  },
  {
    label: "Credentials",
    items: [
      { type: "credential", label: "Password", description: "Username & password", icon: KeyIcon, color: "text-entry-credential", credentialType: "generic" },
      { type: "credential", label: "SSH Key", description: "Key pair & fingerprint", icon: ShieldLockIcon, color: "text-entry-sshkey", credentialType: "ssh_key" },
    ],
  },
];

/** Step 1 of a new entry: the type chips, grouped, on neutral tiles in their entry colors. */
export default function EntryTypeStep({ onSelect }: { onSelect: (option: TypeOption) => void }) {
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      {ENTRY_TYPE_CATEGORIES.map((category) => (
        <div key={category.label}>
          <p className="mb-2 px-0.5 text-meta font-semibold text-ink-muted">{category.label}</p>
          <div className="flex flex-wrap gap-2">
            {category.items.map((option) => {
              const TypeIcon = option.icon;
              return (
                <button
                  key={`${option.type}-${option.credentialType ?? ""}`}
                  type="button"
                  onClick={() => onSelect(option)}
                  className={cx("flex h-control-lg items-center gap-2 rounded-md border border-card-border bg-well px-3 hover:bg-hover", COLOR_TRANSITION, option.color)}
                >
                  <TypeIcon size={16} />
                  <span className="whitespace-nowrap text-label font-semibold">{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
