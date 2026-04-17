import welcomeVideo from "../../assets/onboarding/welcome.webm";
import vaultVideo from "../../assets/onboarding/vault.webm";
import connectionsVideo from "../../assets/onboarding/connections.webm";
import organizeVideo from "../../assets/onboarding/organize.webm";
import aiAssistantVideo from "../../assets/onboarding/ai-assistant.webm";
import mcpToolsVideo from "../../assets/onboarding/mcp-tools.webm";
import cloudSyncVideo from "../../assets/onboarding/cloud-sync.webm";
import teamVaultsVideo from "../../assets/onboarding/team-vaults.webm";
import permissionsVideo from "../../assets/onboarding/permissions.webm";
import auditTrailVideo from "../../assets/onboarding/audit-trail.webm";
import {
  CloudIcon, HistoryIcon, LockIcon, PlugIcon, RobotIcon, RocketIcon, ShieldLockIcon, StarFilledIcon, TerminalIcon, UsersIcon,
} from "../../lib/icons";
import type { IconComponent } from "../../lib/icons";

export type TierLevel = "free" | "pro" | "teams";

export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  details: string[];
  icon: IconComponent;
  minTier: TierLevel;
  video?: string;
}

const TIER_ORDER: Record<TierLevel, number> = { free: 0, pro: 1, teams: 2 };

const allSteps: OnboardingStep[] = [
  // Free tier (4 steps)
  {
    id: "welcome",
    title: "Welcome to Conduit",
    description:
      "Your all-in-one remote connection manager. Securely store credentials, connect to servers, and manage your infrastructure from a single interface.",
    details: [
      "Manage SSH, RDP, VNC, and web sessions in one place",
      "Zero-knowledge encryption keeps your data safe",
      "Cross-platform support for macOS and Windows",
      "Built-in tools like password and SSH key generators",
    ],
    icon: RocketIcon,
    video: welcomeVideo,
    minTier: "free",
  },
  {
    id: "vault",
    title: "Your Vault",
    description:
      "Everything is stored in an encrypted vault secured by your master password. Your credentials never leave your device unencrypted.",
    details: [
      "AES-256-GCM encryption derived from your master password",
      "Vault files are portable — move or back them up freely",
      "Multiple vaults for separating work and personal credentials",
      "Auto-lock after inactivity to protect unattended sessions",
    ],
    icon: ShieldLockIcon,
    video: vaultVideo,
    minTier: "free",
  },
  {
    id: "connections",
    title: "Connections & Credentials",
    description:
      "Connect via SSH, RDP, VNC, or web sessions. Store passwords, SSH keys, and domain credentials that auto-fill when you connect.",
    details: [
      "SSH terminals with full color, resize, and key forwarding",
      "RDP with clipboard sync, drive redirection, and dynamic resize",
      "VNC for screen sharing with multiple encoding support",
      "Web sessions for browser-based admin panels and dashboards",
      "Credentials auto-fill on connect — no copy-pasting passwords",
    ],
    icon: PlugIcon,
    video: connectionsVideo,
    minTier: "free",
  },
  {
    id: "organize",
    title: "Organize Your Workspace",
    description:
      "Use folders to group connections, star your favorites for quick access, and add tags to find anything instantly.",
    details: [
      "Nested folders for organizing by environment, team, or project",
      "Star frequently-used connections for one-click access",
      "Tags and search to filter across your entire vault",
      "Drag and drop to rearrange your sidebar",
      "Quick Connect for one-off sessions without saving",
    ],
    icon: StarFilledIcon,
    video: organizeVideo,
    minTier: "free",
  },

  // Pro tier (3 additional)
  {
    id: "ai-assistant",
    title: "AI Assistant",
    description:
      "Chat with an AI that understands your connections. Ask questions, run commands, and get context-aware help.",
    details: [
      "Context-aware — the AI sees your active session and connection details",
      "Ask questions like \"what services are running on this server?\"",
      "Get command suggestions and troubleshooting help in real-time",
      "Multiple AI engine support with configurable providers",
    ],
    icon: RobotIcon,
    video: aiAssistantVideo,
    minTier: "pro",
  },
  {
    id: "mcp-tools",
    title: "MCP Tools & CLI Agents",
    description:
      "AI agents like Claude Code can interact with your connections in real-time through MCP tools.",
    details: [
      "External AI agents execute commands on your connections",
      "Read screens, navigate RDP sessions, and transfer files",
      "Approval flow for sensitive actions — you stay in control",
      "Unix socket protocol for secure local communication",
    ],
    icon: TerminalIcon,
    video: mcpToolsVideo,
    minTier: "pro",
  },
  {
    id: "cloud-sync",
    title: "Cloud Backup & Sync",
    description:
      "Your encrypted vault backs up to the cloud automatically. Restore on any device with your master password.",
    details: [
      "End-to-end encrypted — the server never sees your data",
      "Automatic sync after every vault change",
      "Restore your full vault on a new device with just your master password",
      "Zero-knowledge architecture — not even Conduit can read your vault",
    ],
    icon: CloudIcon,
    video: cloudSyncVideo,
    minTier: "pro",
  },

  // Teams tier (3 additional)
  {
    id: "team-vaults",
    title: "Team Vaults",
    description:
      "Share encrypted vaults with your team. Each member gets their own encryption key — no shared passwords needed.",
    details: [
      "Invite team members by email — they join with their own device key",
      "Zero-knowledge key exchange — credentials are never exposed in transit",
      "Per-member encryption means revoking access is instant and complete",
      "Team and personal vaults coexist — switch between them freely",
    ],
    icon: UsersIcon,
    video: teamVaultsVideo,
    minTier: "teams",
  },
  {
    id: "permissions",
    title: "Permissions & Roles",
    description:
      "Control access at the folder level with admin, editor, and viewer roles.",
    details: [
      "Three roles: Admin (full control), Editor (modify), Viewer (read-only)",
      "Folder-level permissions for granular access control",
      "Permissions can only restrict — never escalate beyond a member's vault role",
      "Admins manage membership, roles, and vault-wide settings",
    ],
    icon: LockIcon,
    video: permissionsVideo,
    minTier: "teams",
  },
  {
    id: "audit-trail",
    title: "Audit Trail",
    description:
      "Every action in your team vault is logged. Track who accessed what, when, and maintain compliance.",
    details: [
      "Full activity log: credential access, edits, member changes, and more",
      "Filter by action type, member, or date range",
      "2-year retention policy for compliance and security reviews",
      "Exportable logs for external audit tooling",
    ],
    icon: HistoryIcon,
    video: auditTrailVideo,
    minTier: "teams",
  },
];

export function getStepsForTier(tier: TierLevel): OnboardingStep[] {
  const maxOrder = TIER_ORDER[tier];
  return allSteps.filter((step) => TIER_ORDER[step.minTier] <= maxOrder);
}

export function getUserTierLevel(
  tierName: string | undefined,
  isTeamMember: boolean
): TierLevel {
  if (isTeamMember) return "teams";
  if (tierName?.toLowerCase() === "pro") return "pro";
  return "free";
}
