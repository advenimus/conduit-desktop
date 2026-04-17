/**
 * Curated icon registry for custom entry/folder icons.
 * Only icons referenced here are bundled (tree-shaking friendly).
 */
import {
  // Connections
  IconTerminal2,
  IconDeviceDesktop,
  IconServer2,
  IconWorld,
  IconCloud,
  IconDatabase,
  IconRouter,
  IconNetwork,
  IconWifi,
  IconApi,
  // Security
  IconKey,
  IconLock,
  IconShieldLock,
  IconFingerprint,
  IconCertificate,
  // Development
  IconCode,
  IconBug,
  IconBrandDocker,
  IconBrandGithub,
  IconTool,
  IconTerminal,
  IconBraces,
  IconGitBranch,
  // Platforms
  IconBrandAws,
  IconBrandAzure,
  IconBrandWindows,
  IconBrandApple,
  IconBrandRedhat,
  IconBrandUbuntu,
  IconBrandDebian,
  // Hardware
  IconCpu,
  IconDeviceFloppy,
  IconServer,
  IconDeviceNintendo,
  // Files
  IconFolder,
  IconFolderOpen,
  IconFileText,
  IconArchive,
  IconFiles,
  // Organization
  IconHome,
  IconBuilding,
  IconUsers,
  IconUser,
  IconBriefcase,
  IconSitemap,
  // Status / Markers
  IconStar,
  IconHeart,
  IconBookmark,
  IconFlag,
  IconTag,
  IconBolt,
  IconRocket,
  IconDiamond,
  IconCrown,
  IconFlame,
  IconMedal,
  IconTrophy,
  // Analytics
  IconChartBar,
  IconChartPie,
  IconTrendingUp,
  // Misc
  IconCloudComputing,
  IconWorldWww,
  IconPlayerPlay,
  IconPuzzle,
  IconPackage,
} from "@tabler/icons-react";
import type { Icon as TablerIcon } from "@tabler/icons-react";

export interface IconCategory {
  label: string;
  icons: { name: string; component: TablerIcon }[];
}

export const ICON_CATEGORIES: IconCategory[] = [
  {
    label: "Connections",
    icons: [
      { name: "IconTerminal2", component: IconTerminal2 },
      { name: "IconDeviceDesktop", component: IconDeviceDesktop },
      { name: "IconServer2", component: IconServer2 },
      { name: "IconWorld", component: IconWorld },
      { name: "IconCloud", component: IconCloud },
      { name: "IconDatabase", component: IconDatabase },
      { name: "IconRouter", component: IconRouter },
      { name: "IconNetwork", component: IconNetwork },
      { name: "IconWifi", component: IconWifi },
      { name: "IconApi", component: IconApi },
      { name: "IconCloudComputing", component: IconCloudComputing },
      { name: "IconWorldWww", component: IconWorldWww },
    ],
  },
  {
    label: "Security",
    icons: [
      { name: "IconKey", component: IconKey },
      { name: "IconLock", component: IconLock },
      { name: "IconShieldLock", component: IconShieldLock },
      { name: "IconFingerprint", component: IconFingerprint },
      { name: "IconCertificate", component: IconCertificate },
    ],
  },
  {
    label: "Development",
    icons: [
      { name: "IconCode", component: IconCode },
      { name: "IconBug", component: IconBug },
      { name: "IconBrandDocker", component: IconBrandDocker },
      { name: "IconBrandGithub", component: IconBrandGithub },
      { name: "IconTool", component: IconTool },
      { name: "IconTerminal", component: IconTerminal },
      { name: "IconBraces", component: IconBraces },
      { name: "IconGitBranch", component: IconGitBranch },
    ],
  },
  {
    label: "Platforms",
    icons: [
      { name: "IconBrandAws", component: IconBrandAws },
      { name: "IconBrandAzure", component: IconBrandAzure },
      { name: "IconBrandWindows", component: IconBrandWindows },
      { name: "IconBrandApple", component: IconBrandApple },
      { name: "IconBrandRedhat", component: IconBrandRedhat },
      { name: "IconBrandUbuntu", component: IconBrandUbuntu },
      { name: "IconBrandDebian", component: IconBrandDebian },
    ],
  },
  {
    label: "Hardware",
    icons: [
      { name: "IconCpu", component: IconCpu },
      { name: "IconDeviceFloppy", component: IconDeviceFloppy },
      { name: "IconServer", component: IconServer },
      { name: "IconDeviceNintendo", component: IconDeviceNintendo },
    ],
  },
  {
    label: "Files",
    icons: [
      { name: "IconFolder", component: IconFolder },
      { name: "IconFolderOpen", component: IconFolderOpen },
      { name: "IconFileText", component: IconFileText },
      { name: "IconArchive", component: IconArchive },
      { name: "IconFiles", component: IconFiles },
    ],
  },
  {
    label: "Organization",
    icons: [
      { name: "IconHome", component: IconHome },
      { name: "IconBuilding", component: IconBuilding },
      { name: "IconUsers", component: IconUsers },
      { name: "IconUser", component: IconUser },
      { name: "IconBriefcase", component: IconBriefcase },
      { name: "IconSitemap", component: IconSitemap },
    ],
  },
  {
    label: "Status",
    icons: [
      { name: "IconStar", component: IconStar },
      { name: "IconHeart", component: IconHeart },
      { name: "IconBookmark", component: IconBookmark },
      { name: "IconFlag", component: IconFlag },
      { name: "IconTag", component: IconTag },
      { name: "IconBolt", component: IconBolt },
      { name: "IconRocket", component: IconRocket },
      { name: "IconDiamond", component: IconDiamond },
      { name: "IconCrown", component: IconCrown },
      { name: "IconFlame", component: IconFlame },
      { name: "IconMedal", component: IconMedal },
      { name: "IconTrophy", component: IconTrophy },
    ],
  },
  {
    label: "Analytics",
    icons: [
      { name: "IconChartBar", component: IconChartBar },
      { name: "IconChartPie", component: IconChartPie },
      { name: "IconTrendingUp", component: IconTrendingUp },
    ],
  },
  {
    label: "Misc",
    icons: [
      { name: "IconPlayerPlay", component: IconPlayerPlay },
      { name: "IconPuzzle", component: IconPuzzle },
      { name: "IconPackage", component: IconPackage },
    ],
  },
];

/** Flat lookup map: icon name → component */
export const ICON_MAP = new Map<string, TablerIcon>(
  ICON_CATEGORIES.flatMap((cat) => cat.icons.map((i) => [i.name, i.component] as [string, TablerIcon]))
);

/** Resolve an icon name to its component. Returns null if not found. */
export function resolveIcon(name: string | null | undefined): TablerIcon | null {
  if (!name) return null;
  return ICON_MAP.get(name) ?? null;
}
