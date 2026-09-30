/**
 * Curated icon registry for custom entry/folder icons.
 * Only icons referenced here are bundled (tree-shaking friendly).
 */
import { createElement, memo } from "react";
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
import {
  BoltIcon,
  BugIcon,
  CloudIcon,
  CodeIcon,
  CrownIcon,
  DatabaseIcon,
  DesktopIcon,
  FileTextIcon,
  FingerprintIcon,
  FloppyIcon,
  FolderIcon,
  FolderOpenIcon,
  GlobeIcon,
  GlobeWwwIcon,
  HomeIcon,
  KeyIcon,
  LockIcon,
  NetworkIcon,
  PlayerPlayIcon,
  RocketIcon,
  ServerAltIcon,
  ServerIcon,
  ShieldLockIcon,
  StarIcon,
  TagIcon,
  TerminalAltIcon,
  TerminalIcon,
  ToolIcon,
  UserIcon,
  UsersIcon,
  type IconComponent,
  type IconProps,
  type SemanticIconName,
} from "../../lib/icons";

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

/** Flat lookup map: icon name -> the curated Tabler component (what the name meant when stored). */
export const ICON_MAP = new Map<string, TablerIcon>(
  ICON_CATEGORIES.flatMap((cat) => cat.icons.map((i) => [i.name, i.component] as [string, TablerIcon]))
);

/**
 * Stored names whose glyph the Tabler pack itself maps from a semantic name (spec 5.11). These draw
 * through the active icon pack; the other curated names keep their Tabler glyph in every pack. The
 * stored names never change, so older builds and other devices read the same vault data.
 */
export const CUSTOM_ICON_TWINS: Readonly<Record<string, SemanticIconName>> = Object.freeze({
  IconTerminal2: "terminal",
  IconTerminal: "terminalAlt",
  IconDeviceDesktop: "desktop",
  IconServer: "server",
  IconServer2: "serverAlt",
  IconWorld: "globe",
  IconWorldWww: "globeWww",
  IconCloud: "cloud",
  IconDatabase: "database",
  IconNetwork: "network",
  IconKey: "key",
  IconLock: "lock",
  IconShieldLock: "shieldLock",
  IconFingerprint: "fingerprint",
  IconCode: "code",
  IconBug: "bug",
  IconTool: "tool",
  IconDeviceFloppy: "floppy",
  IconFolder: "folder",
  IconFolderOpen: "folderOpen",
  IconFileText: "fileText",
  IconHome: "home",
  IconUser: "user",
  IconUsers: "users",
  IconStar: "star",
  IconTag: "tag",
  IconBolt: "bolt",
  IconRocket: "rocket",
  IconCrown: "crown",
  IconPlayerPlay: "playerPlay",
});

const THEMED_TWINS: Readonly<Partial<Record<SemanticIconName, IconComponent>>> = {
  terminal: TerminalIcon,
  terminalAlt: TerminalAltIcon,
  desktop: DesktopIcon,
  server: ServerIcon,
  serverAlt: ServerAltIcon,
  globe: GlobeIcon,
  globeWww: GlobeWwwIcon,
  cloud: CloudIcon,
  database: DatabaseIcon,
  network: NetworkIcon,
  key: KeyIcon,
  lock: LockIcon,
  shieldLock: ShieldLockIcon,
  fingerprint: FingerprintIcon,
  code: CodeIcon,
  bug: BugIcon,
  tool: ToolIcon,
  floppy: FloppyIcon,
  folder: FolderIcon,
  folderOpen: FolderOpenIcon,
  fileText: FileTextIcon,
  home: HomeIcon,
  user: UserIcon,
  users: UsersIcon,
  star: StarIcon,
  tag: TagIcon,
  bolt: BoltIcon,
  rocket: RocketIcon,
  crown: CrownIcon,
  playerPlay: PlayerPlayIcon,
};

/** A Tabler glyph behind the IconProps API; `compact` is a pack option a raw SVG must not receive. */
function asIconComponent(Tabler: TablerIcon): IconComponent {
  const Adapted = memo(function CuratedTablerIcon({ size, className, style, stroke, title }: IconProps) {
    return createElement(Tabler, { size, className, style, stroke, title });
  });
  Adapted.displayName = `Curated(${Tabler.displayName ?? "icon"})`;
  return Adapted;
}

const RESOLVED = new Map<string, IconComponent>(
  [...ICON_MAP].map(([name, Tabler]) => {
    const twin = CUSTOM_ICON_TWINS[name];
    const themed = twin ? THEMED_TWINS[twin] : undefined;
    return [name, themed ?? asIconComponent(Tabler)];
  }),
);

/** Resolve a stored icon name to the component that draws it. Returns null if not found. */
export function resolveIcon(name: string | null | undefined): IconComponent | null {
  if (!name) return null;
  return RESOLVED.get(name) ?? null;
}
