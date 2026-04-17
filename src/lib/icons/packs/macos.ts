/**
 * macOS Tahoe icon pack — maps semantic names to @phosphor-icons/react.
 * Phosphor icons have an SF Symbols feel: rounded endpoints, variable weight.
 *
 * Phosphor uses a `weight` prop instead of `stroke`. The adapter wrapper
 * in create-themed-icon handles this translation.
 */

import {
  X,
  Plus,
  Check,
  MagnifyingGlass,
  Trash,
  PencilSimple,
  Copy,
  ArrowsClockwise,
  PaperPlaneRight,
  DownloadSimple,
  UploadSimple,
  ArrowSquareOut,
  SignIn,
  SignOut,
  ClockCounterClockwise,
  Gear,
  Eye,
  EyeSlash,
  House,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowsLeftRight,
  CaretDown,
  CaretLeft,
  CaretRight,
  WarningCircle,
  Warning,
  Info,
  CheckCircle,
  XCircle,
  Prohibit,
  SpinnerGap,
  WifiSlash,
  Lock,
  LockOpen,
  Key,
  Shield,
  ShieldCheck,
  ShieldWarning,
  Fingerprint,
  File,
  FileCode,
  FileArrowDown,
  FilePlus,
  FileText,
  FileX,
  Folder,
  FolderOpen,
  FolderPlus,
  User,
  Users,
  Crown,
  Terminal,
  TerminalWindow,
  Desktop,
  Globe,
  GlobeSimple,
  HardDrives,
  HardDrive,
  DeviceMobile,
  TreeStructure,
  Plug,
  PlugsConnected,
  Star,
  PushPin,
  Database,
  ClockClockwise,
  Calendar,
  Clock,
  Tag,
  Notepad,
  Envelope,
  ChatCircle,
  ChatCircleDots,
  Cloud,
  CloudSlash,
  CloudArrowDown,
  Robot,
  Sparkle,
  Wrench,
  Stack,
  Lightning,
  Rocket,
  Play,
  Stop,
  SkipForward,
  Keyboard,
  QrCode,
  Crosshair,
  Palette,
  GridFour,
  Image,
  Hammer,
  Bug,
  FloppyDisk,
  TextB,
  TextItalic,
  TextStrikethrough,
  TextHOne,
  TextHTwo,
  Link,
  Code,
  ListBullets,
  ListNumbers,
  Table,
  Quotes,
} from "@phosphor-icons/react";

import React from "react";
import type { IconMapping, IconComponent, IconProps } from "../types";

/**
 * Phosphor icons use `weight` instead of `stroke`.
 * This wrapper translates our standard props.
 */
function wrap(PhosphorIcon: React.ComponentType<any>): IconComponent {
  const Wrapped = React.memo(function WrappedPhosphorIcon(props: IconProps) {
    return React.createElement(PhosphorIcon, {
      size: props.size,
      weight: "regular",
      className: props.className,
      style: props.style,
    });
  });
  Wrapped.displayName = `Phosphor(${PhosphorIcon.displayName || "icon"})`;
  return Wrapped;
}

export const mapping: IconMapping = {
  // ── Actions ──
  close: wrap(X),
  plus: wrap(Plus),
  check: wrap(Check),
  search: wrap(MagnifyingGlass),
  trash: wrap(Trash),
  pencil: wrap(PencilSimple),
  copy: wrap(Copy),
  refresh: wrap(ArrowsClockwise),
  send: wrap(PaperPlaneRight),
  download: wrap(DownloadSimple),
  upload: wrap(UploadSimple),
  externalLink: wrap(ArrowSquareOut),
  login: wrap(SignIn),
  logout: wrap(SignOut),
  restore: wrap(ClockCounterClockwise),
  settings: wrap(Gear),
  eye: wrap(Eye),
  eyeOff: wrap(EyeSlash),

  // ── Navigation ──
  home: wrap(House),
  arrowLeft: wrap(ArrowLeft),
  arrowRight: wrap(ArrowRight),
  arrowUp: wrap(ArrowUp),
  arrowsExchange: wrap(ArrowsLeftRight),
  chevronDown: wrap(CaretDown),
  chevronLeft: wrap(CaretLeft),
  chevronRight: wrap(CaretRight),

  // ── Status ──
  alertCircle: wrap(WarningCircle),
  alertTriangle: wrap(Warning),
  infoCircle: wrap(Info),
  circleCheck: wrap(CheckCircle),
  circleX: wrap(XCircle),
  ban: wrap(Prohibit),
  loader: wrap(SpinnerGap),
  wifiOff: wrap(WifiSlash),

  // ── Security ──
  lock: wrap(Lock),
  lockOpen: wrap(LockOpen),
  key: wrap(Key),
  shield: wrap(Shield),
  shieldCheck: wrap(ShieldCheck),
  shieldLock: wrap(ShieldWarning),
  fingerprint: wrap(Fingerprint),

  // ── Files & Folders ──
  file: wrap(File),
  fileCode: wrap(FileCode),
  fileImport: wrap(FileArrowDown),
  filePlus: wrap(FilePlus),
  fileText: wrap(FileText),
  fileX: wrap(FileX),
  folder: wrap(Folder),
  folderOpen: wrap(FolderOpen),
  folderPlus: wrap(FolderPlus),

  // ── People ──
  user: wrap(User),
  users: wrap(Users),
  crown: wrap(Crown),

  // ── Connection types ──
  terminal: wrap(TerminalWindow),
  terminalAlt: wrap(Terminal),
  desktop: wrap(Desktop),
  globe: wrap(Globe),
  globeWww: wrap(GlobeSimple),
  server: wrap(HardDrive),
  serverAlt: wrap(HardDrives),
  devices: wrap(DeviceMobile),
  deviceMobile: wrap(DeviceMobile),
  network: wrap(TreeStructure),
  plug: wrap(Plug),
  plugDisconnected: wrap(PlugsConnected),

  // ── Favorites ──
  star: wrap(Star),
  starFilled: wrap(Star), // Phosphor uses weight="fill" — handled by variant later
  pinFilled: wrap(PushPin),

  // ── Data ──
  database: wrap(Database),
  history: wrap(ClockClockwise),
  calendar: wrap(Calendar),
  clock: wrap(Clock),
  tag: wrap(Tag),
  notes: wrap(Notepad),

  // ── Communication ──
  mail: wrap(Envelope),
  message: wrap(ChatCircle),
  messageChatbot: wrap(ChatCircleDots),

  // ── Cloud ──
  cloud: wrap(Cloud),
  cloudOff: wrap(CloudSlash),
  cloudDownload: wrap(CloudArrowDown),

  // ── AI / Automation ──
  robot: wrap(Robot),
  sparkles: wrap(Sparkle),
  tool: wrap(Wrench),
  stack: wrap(Stack),
  bolt: wrap(Lightning),
  rocket: wrap(Rocket),

  // ── Media / Controls ──
  playerPlay: wrap(Play),
  playerStop: wrap(Stop),
  playerStopFilled: wrap(Stop),
  playerSkipForward: wrap(SkipForward),

  // ── Input ──
  keyboard: wrap(Keyboard),
  qrcode: wrap(QrCode),
  target: wrap(Crosshair),

  // ── Appearance ──
  palette: wrap(Palette),
  icons: wrap(GridFour),
  photo: wrap(Image),

  // ── Misc ──
  hammer: wrap(Hammer),
  bug: wrap(Bug),
  floppy: wrap(FloppyDisk),

  // ── Markdown toolbar ──
  bold: wrap(TextB),
  italic: wrap(TextItalic),
  strikethrough: wrap(TextStrikethrough),
  heading1: wrap(TextHOne),
  heading2: wrap(TextHTwo),
  link: wrap(Link),
  code: wrap(Code),
  list: wrap(ListBullets),
  listNumbers: wrap(ListNumbers),
  table: wrap(Table),
  quote: wrap(Quotes),
};
