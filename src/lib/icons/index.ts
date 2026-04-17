/**
 * Themed icon system — barrel exports.
 *
 * Components import from here instead of @tabler/icons-react directly.
 * Each export is a React component that renders the correct icon for
 * the active platform theme.
 *
 * Usage:
 *   import { CloseIcon, SettingsIcon } from "../../lib/icons";
 *   <CloseIcon size={14} />
 *   <SettingsIcon size={16} className="text-ink-muted" />
 */

import { createThemedIcon } from "./create-themed-icon";

// ── Actions ──
export const CloseIcon = createThemedIcon("close");
export const PlusIcon = createThemedIcon("plus");
export const CheckIcon = createThemedIcon("check");
export const SearchIcon = createThemedIcon("search");
export const TrashIcon = createThemedIcon("trash");
export const PencilIcon = createThemedIcon("pencil");
export const CopyIcon = createThemedIcon("copy");
export const RefreshIcon = createThemedIcon("refresh");
export const SendIcon = createThemedIcon("send");
export const DownloadIcon = createThemedIcon("download");
export const UploadIcon = createThemedIcon("upload");
export const ExternalLinkIcon = createThemedIcon("externalLink");
export const LoginIcon = createThemedIcon("login");
export const LogoutIcon = createThemedIcon("logout");
export const RestoreIcon = createThemedIcon("restore");
export const SettingsIcon = createThemedIcon("settings");
export const EyeIcon = createThemedIcon("eye");
export const EyeOffIcon = createThemedIcon("eyeOff");

// ── Navigation ──
export const HomeIcon = createThemedIcon("home");
export const ArrowLeftIcon = createThemedIcon("arrowLeft");
export const ArrowRightIcon = createThemedIcon("arrowRight");
export const ArrowUpIcon = createThemedIcon("arrowUp");
export const ArrowsExchangeIcon = createThemedIcon("arrowsExchange");
export const ChevronDownIcon = createThemedIcon("chevronDown");
export const ChevronLeftIcon = createThemedIcon("chevronLeft");
export const ChevronRightIcon = createThemedIcon("chevronRight");

// ── Status ──
export const AlertCircleIcon = createThemedIcon("alertCircle");
export const AlertTriangleIcon = createThemedIcon("alertTriangle");
export const InfoCircleIcon = createThemedIcon("infoCircle");
export const CircleCheckIcon = createThemedIcon("circleCheck");
export const CircleXIcon = createThemedIcon("circleX");
export const BanIcon = createThemedIcon("ban");
export const LoaderIcon = createThemedIcon("loader");
export const WifiOffIcon = createThemedIcon("wifiOff");

// ── Security ──
export const LockIcon = createThemedIcon("lock");
export const LockOpenIcon = createThemedIcon("lockOpen");
export const KeyIcon = createThemedIcon("key");
export const ShieldIcon = createThemedIcon("shield");
export const ShieldCheckIcon = createThemedIcon("shieldCheck");
export const ShieldLockIcon = createThemedIcon("shieldLock");
export const FingerprintIcon = createThemedIcon("fingerprint");

// ── Files & Folders ──
export const FileIcon = createThemedIcon("file");
export const FileCodeIcon = createThemedIcon("fileCode");
export const FileImportIcon = createThemedIcon("fileImport");
export const FilePlusIcon = createThemedIcon("filePlus");
export const FileTextIcon = createThemedIcon("fileText");
export const FileXIcon = createThemedIcon("fileX");
export const FolderIcon = createThemedIcon("folder");
export const FolderOpenIcon = createThemedIcon("folderOpen");
export const FolderPlusIcon = createThemedIcon("folderPlus");

// ── People ──
export const UserIcon = createThemedIcon("user");
export const UsersIcon = createThemedIcon("users");
export const CrownIcon = createThemedIcon("crown");

// ── Connection types ──
export const TerminalIcon = createThemedIcon("terminal");
export const TerminalAltIcon = createThemedIcon("terminalAlt");
export const DesktopIcon = createThemedIcon("desktop");
export const GlobeIcon = createThemedIcon("globe");
export const GlobeWwwIcon = createThemedIcon("globeWww");
export const ServerIcon = createThemedIcon("server");
export const ServerAltIcon = createThemedIcon("serverAlt");
export const DevicesIcon = createThemedIcon("devices");
export const NetworkIcon = createThemedIcon("network");
export const PlugIcon = createThemedIcon("plug");
export const PlugDisconnectedIcon = createThemedIcon("plugDisconnected");

// ── Favorites ──
export const StarIcon = createThemedIcon("star");
export const StarFilledIcon = createThemedIcon("starFilled");
export const PinFilledIcon = createThemedIcon("pinFilled");

// ── Data ──
export const DatabaseIcon = createThemedIcon("database");
export const HistoryIcon = createThemedIcon("history");
export const CalendarIcon = createThemedIcon("calendar");
export const ClockIcon = createThemedIcon("clock");
export const TagIcon = createThemedIcon("tag");
export const NotesIcon = createThemedIcon("notes");

// ── Communication ──
export const MailIcon = createThemedIcon("mail");
export const MessageIcon = createThemedIcon("message");
export const MessageChatbotIcon = createThemedIcon("messageChatbot");

// ── Cloud ──
export const CloudIcon = createThemedIcon("cloud");
export const CloudOffIcon = createThemedIcon("cloudOff");
export const CloudDownloadIcon = createThemedIcon("cloudDownload");

// ── AI / Automation ──
export const RobotIcon = createThemedIcon("robot");
export const SparklesIcon = createThemedIcon("sparkles");
export const ToolIcon = createThemedIcon("tool");
export const StackIcon = createThemedIcon("stack");
export const BoltIcon = createThemedIcon("bolt");
export const RocketIcon = createThemedIcon("rocket");

// ── Media / Controls ──
export const PlayerPlayIcon = createThemedIcon("playerPlay");
export const PlayerStopIcon = createThemedIcon("playerStop");
export const PlayerStopFilledIcon = createThemedIcon("playerStopFilled");
export const PlayerSkipForwardIcon = createThemedIcon("playerSkipForward");

// ── Input ──
export const KeyboardIcon = createThemedIcon("keyboard");
export const QrcodeIcon = createThemedIcon("qrcode");
export const TargetIcon = createThemedIcon("target");

// ── Appearance ──
export const PaletteIcon = createThemedIcon("palette");
export const IconsIcon = createThemedIcon("icons");
export const PhotoIcon = createThemedIcon("photo");

// ── Devices ──
export const DeviceMobileIcon = createThemedIcon("deviceMobile");

// ── Misc ──
export const HammerIcon = createThemedIcon("hammer");
export const BugIcon = createThemedIcon("bug");
export const FloppyIcon = createThemedIcon("floppy");

// ── Markdown toolbar ──
export const BoldIcon = createThemedIcon("bold");
export const ItalicIcon = createThemedIcon("italic");
export const StrikethroughIcon = createThemedIcon("strikethrough");
export const Heading1Icon = createThemedIcon("heading1");
export const Heading2Icon = createThemedIcon("heading2");
export const LinkIcon = createThemedIcon("link");
export const CodeIcon = createThemedIcon("code");
export const ListIcon = createThemedIcon("list");
export const ListNumbersIcon = createThemedIcon("listNumbers");
export const TableIcon = createThemedIcon("table");
export const QuoteIcon = createThemedIcon("quote");

// ── Re-exports for type usage ──
export type { SemanticIconName, IconProps, IconComponent, IconTheme } from "./types";
export { useIconThemeStore } from "./theme-store";
export { loadIconPack } from "./loader";
