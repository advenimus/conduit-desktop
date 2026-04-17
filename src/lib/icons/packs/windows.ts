/**
 * Windows 11 icon pack — maps semantic names to @fluentui/react-icons.
 * Fluent UI icons are the actual Windows 11 system icons.
 */

import {
  DismissRegular,
  AddRegular,
  CheckmarkRegular,
  SearchRegular,
  DeleteRegular,
  EditRegular,
  CopyRegular,
  ArrowSyncRegular,
  SendRegular,
  ArrowDownloadRegular,
  ArrowUploadRegular,
  OpenRegular,
  PersonArrowRightRegular,
  PersonArrowLeftRegular,
  HistoryRegular,
  SettingsRegular,
  EyeRegular,
  EyeOffRegular,
  HomeRegular,
  ArrowLeftRegular,
  ArrowRightRegular,
  ArrowUpRegular,
  ArrowSwapRegular,
  ChevronDownRegular,
  ChevronLeftRegular,
  ChevronRightRegular,
  ErrorCircleRegular,
  WarningRegular,
  InfoRegular,
  CheckmarkCircleRegular,
  DismissCircleRegular,
  ProhibitedRegular,
  SpinnerIosRegular,
  WifiOffRegular,
  LockClosedRegular,
  LockOpenRegular,
  KeyRegular,
  ShieldRegular,
  ShieldCheckmarkRegular,
  ShieldLockRegular,
  FingerprintRegular,
  DocumentRegular,
  DocumentCode16Regular,
  DocumentArrowDownRegular,
  DocumentAddRegular,
  DocumentTextRegular,
  DocumentDismissRegular,
  FolderRegular,
  FolderOpenRegular,
  FolderAddRegular,
  PersonRegular,
  PeopleRegular,
  PeopleTeamRegular as CrownIcon,
  WindowConsoleRegular,
  DesktopRegular,
  GlobeRegular,
  ServerRegular,
  PhoneDesktopRegular,
  PhoneRegular,
  BranchRegular,
  PlugDisconnectedRegular,
  PlugConnectedRegular,
  StarRegular,
  StarFilled,
  PinRegular,
  DatabaseRegular,
  CalendarRegular,
  ClockRegular,
  TagRegular,
  NoteRegular,
  MailRegular,
  ChatRegular,
  ChatMultipleRegular,
  CloudRegular,
  CloudOffRegular,
  CloudArrowDownRegular,
  BotRegular,
  SparkleRegular,
  WrenchRegular,
  StackRegular,
  FlashRegular,
  RocketRegular,
  PlayRegular,
  StopRegular,
  StopFilled,
  NextRegular,
  KeyboardRegular,
  QrCodeRegular,
  TargetRegular,
  ColorRegular,
  GridRegular,
  ImageRegular,
  WrenchScrewdriverRegular,
  BugRegular,
  SaveRegular,
  TextBoldRegular,
  TextItalicRegular,
  TextStrikethroughRegular,
  TextHeader1Regular,
  TextHeader2Regular,
  LinkRegular,
  CodeRegular,
  TextBulletListRegular,
  TextNumberListLtrRegular,
  TableRegular,
  TextQuoteRegular,
} from "@fluentui/react-icons";

import React from "react";
import type { IconMapping, IconComponent, IconProps } from "../types";

/**
 * Fluent icons use `fontSize` and have no stroke prop.
 * This wrapper translates our standard props.
 */
function wrap(FluentIcon: React.ComponentType<any>): IconComponent {
  const Wrapped = React.memo(function WrappedFluentIcon(props: IconProps) {
    return React.createElement(FluentIcon, {
      style: { fontSize: props.size, ...props.style },
      className: props.className,
    });
  });
  Wrapped.displayName = `Fluent(${FluentIcon.displayName || "icon"})`;
  return Wrapped;
}

export const mapping: IconMapping = {
  // ── Actions ──
  close: wrap(DismissRegular),
  plus: wrap(AddRegular),
  check: wrap(CheckmarkRegular),
  search: wrap(SearchRegular),
  trash: wrap(DeleteRegular),
  pencil: wrap(EditRegular),
  copy: wrap(CopyRegular),
  refresh: wrap(ArrowSyncRegular),
  send: wrap(SendRegular),
  download: wrap(ArrowDownloadRegular),
  upload: wrap(ArrowUploadRegular),
  externalLink: wrap(OpenRegular),
  login: wrap(PersonArrowRightRegular),
  logout: wrap(PersonArrowLeftRegular),
  restore: wrap(HistoryRegular),
  settings: wrap(SettingsRegular),
  eye: wrap(EyeRegular),
  eyeOff: wrap(EyeOffRegular),

  // ── Navigation ──
  home: wrap(HomeRegular),
  arrowLeft: wrap(ArrowLeftRegular),
  arrowRight: wrap(ArrowRightRegular),
  arrowUp: wrap(ArrowUpRegular),
  arrowsExchange: wrap(ArrowSwapRegular),
  chevronDown: wrap(ChevronDownRegular),
  chevronLeft: wrap(ChevronLeftRegular),
  chevronRight: wrap(ChevronRightRegular),

  // ── Status ──
  alertCircle: wrap(ErrorCircleRegular),
  alertTriangle: wrap(WarningRegular),
  infoCircle: wrap(InfoRegular),
  circleCheck: wrap(CheckmarkCircleRegular),
  circleX: wrap(DismissCircleRegular),
  ban: wrap(ProhibitedRegular),
  loader: wrap(SpinnerIosRegular),
  wifiOff: wrap(WifiOffRegular),

  // ── Security ──
  lock: wrap(LockClosedRegular),
  lockOpen: wrap(LockOpenRegular),
  key: wrap(KeyRegular),
  shield: wrap(ShieldRegular),
  shieldCheck: wrap(ShieldCheckmarkRegular),
  shieldLock: wrap(ShieldLockRegular),
  fingerprint: wrap(FingerprintRegular),

  // ── Files & Folders ──
  file: wrap(DocumentRegular),
  fileCode: wrap(DocumentCode16Regular),
  fileImport: wrap(DocumentArrowDownRegular),
  filePlus: wrap(DocumentAddRegular),
  fileText: wrap(DocumentTextRegular),
  fileX: wrap(DocumentDismissRegular),
  folder: wrap(FolderRegular),
  folderOpen: wrap(FolderOpenRegular),
  folderPlus: wrap(FolderAddRegular),

  // ── People ──
  user: wrap(PersonRegular),
  users: wrap(PeopleRegular),
  crown: wrap(CrownIcon),

  // ── Connection types ──
  terminal: wrap(WindowConsoleRegular),
  terminalAlt: wrap(WindowConsoleRegular),
  desktop: wrap(DesktopRegular),
  globe: wrap(GlobeRegular),
  globeWww: wrap(GlobeRegular),
  server: wrap(ServerRegular),
  serverAlt: wrap(ServerRegular),
  devices: wrap(PhoneDesktopRegular),
  deviceMobile: wrap(PhoneRegular),
  network: wrap(BranchRegular),
  plug: wrap(PlugConnectedRegular),
  plugDisconnected: wrap(PlugDisconnectedRegular),

  // ── Favorites ──
  star: wrap(StarRegular),
  starFilled: wrap(StarFilled),
  pinFilled: wrap(PinRegular),

  // ── Data ──
  database: wrap(DatabaseRegular),
  history: wrap(HistoryRegular),
  calendar: wrap(CalendarRegular),
  clock: wrap(ClockRegular),
  tag: wrap(TagRegular),
  notes: wrap(NoteRegular),

  // ── Communication ──
  mail: wrap(MailRegular),
  message: wrap(ChatRegular),
  messageChatbot: wrap(ChatMultipleRegular),

  // ── Cloud ──
  cloud: wrap(CloudRegular),
  cloudOff: wrap(CloudOffRegular),
  cloudDownload: wrap(CloudArrowDownRegular),

  // ── AI / Automation ──
  robot: wrap(BotRegular),
  sparkles: wrap(SparkleRegular),
  tool: wrap(WrenchRegular),
  stack: wrap(StackRegular),
  bolt: wrap(FlashRegular),
  rocket: wrap(RocketRegular),

  // ── Media / Controls ──
  playerPlay: wrap(PlayRegular),
  playerStop: wrap(StopRegular),
  playerStopFilled: wrap(StopFilled),
  playerSkipForward: wrap(NextRegular),

  // ── Input ──
  keyboard: wrap(KeyboardRegular),
  qrcode: wrap(QrCodeRegular),
  target: wrap(TargetRegular),

  // ── Appearance ──
  palette: wrap(ColorRegular),
  icons: wrap(GridRegular),
  photo: wrap(ImageRegular),

  // ── Misc ──
  hammer: wrap(WrenchScrewdriverRegular),
  bug: wrap(BugRegular),
  floppy: wrap(SaveRegular),

  // ── Markdown toolbar ──
  bold: wrap(TextBoldRegular),
  italic: wrap(TextItalicRegular),
  strikethrough: wrap(TextStrikethroughRegular),
  heading1: wrap(TextHeader1Regular),
  heading2: wrap(TextHeader2Regular),
  link: wrap(LinkRegular),
  code: wrap(CodeRegular),
  list: wrap(TextBulletListRegular),
  listNumbers: wrap(TextNumberListLtrRegular),
  table: wrap(TableRegular),
  quote: wrap(TextQuoteRegular),
};
