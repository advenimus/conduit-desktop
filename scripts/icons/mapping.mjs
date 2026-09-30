// Semantic name -> Material Symbols glyph (spec Appendix A.3). `materialFill` marks the
// filled glyphs. circleFilled has no row: every pack draws the shared state dot (spec 5.4).

const row = (name, material, materialFill = false) => Object.freeze({ name, material, materialFill });

export const ICON_MAPPING = Object.freeze([
  // Actions
  row("close", "close-outline-rounded"),
  row("plus", "add-outline-rounded"),
  row("check", "check-outline-rounded"),
  row("search", "search-outline-rounded"),
  row("trash", "delete-outline-rounded"),
  row("pencil", "edit-outline-rounded"),
  row("copy", "content-copy-outline-rounded"),
  row("refresh", "refresh-outline-rounded"),
  row("send", "send-outline-rounded"),
  row("download", "download-outline-rounded"),
  row("upload", "upload-outline-rounded"),
  row("externalLink", "open-in-new-outline-rounded"),
  row("login", "login-outline-rounded"),
  row("logout", "logout-outline-rounded"),
  row("restore", "settings-backup-restore-outline-rounded"),
  row("settings", "settings-outline-rounded"),
  row("eye", "visibility-outline-rounded"),
  row("eyeOff", "visibility-off-outline-rounded"),

  // Navigation
  row("home", "home-outline-rounded"),
  row("arrowLeft", "arrow-back-outline-rounded"),
  row("arrowRight", "arrow-forward-outline-rounded"),
  row("arrowUp", "arrow-upward-outline-rounded"),
  row("arrowsExchange", "swap-horiz-outline-rounded"),
  row("chevronDown", "keyboard-arrow-down-outline-rounded"),
  row("chevronLeft", "chevron-left-outline-rounded"),
  row("chevronRight", "chevron-right-outline-rounded"),

  // Status
  row("alertCircle", "error-outline-rounded"),
  row("alertTriangle", "warning-outline-rounded"),
  row("infoCircle", "info-outline-rounded"),
  row("circleCheck", "check-circle-outline-rounded"),
  row("circleX", "cancel-outline-rounded"),
  row("ban", "block-outline-rounded"),
  row("loader", "progress-activity-outline-rounded"),
  row("wifiOff", "wifi-off-outline-rounded"),

  // Security
  row("lock", "lock-outline-rounded"),
  row("lockOpen", "lock-open-outline-rounded"),
  row("key", "key-outline-rounded"),
  row("shield", "shield-outline-rounded"),
  row("shieldCheck", "verified-user-outline-rounded"),
  row("shieldLock", "shield-lock-outline-rounded"),
  row("fingerprint", "fingerprint-outline-rounded"),

  // Files and folders
  row("file", "draft-outline-rounded"),
  row("fileCode", "code-blocks-outline-rounded"),
  row("fileImport", "file-open-outline-rounded"),
  row("filePlus", "note-add-outline-rounded"),
  row("fileText", "description-outline-rounded"),
  row("fileX", "file-copy-off-outline-rounded"),
  row("folder", "folder-outline-rounded"),
  row("folderOpen", "folder-open-outline-rounded"),
  row("folderPlus", "create-new-folder-outline-rounded"),

  // People
  row("user", "person-outline-rounded"),
  row("users", "group-outline-rounded"),
  row("crown", "crown-outline-rounded"),

  // Connection types
  row("terminal", "terminal-outline-rounded"),
  row("terminalAlt", "terminal-2-outline-rounded"),
  row("desktop", "desktop-windows-outline-rounded"),
  row("globe", "language-outline-rounded"),
  row("globeWww", "globe-outline-rounded"),
  row("server", "dns-outline-rounded"),
  row("serverAlt", "storage-outline-rounded"),
  row("devices", "devices-outline-rounded"),
  row("network", "lan-outline-rounded"),
  row("plug", "power-plug-outline-rounded"),
  row("plugDisconnected", "power-plug-off-outline-rounded"),

  // Favorites
  row("star", "star-outline-rounded"),
  row("starFilled", "star-rounded", true),
  row("pin", "keep-outline-rounded"),
  row("pinFilled", "keep-rounded", true),

  // Data
  row("database", "database-outline-rounded"),
  row("history", "history-outline-rounded"),
  row("calendar", "calendar-today-outline-rounded"),
  row("clock", "schedule-outline-rounded"),
  row("tag", "sell-outline-rounded"),
  row("notes", "sticky-note-2-outline-rounded"),

  // Communication
  row("mail", "mail-outline-rounded"),
  row("message", "chat-bubble-outline-rounded"),
  row("messageChatbot", "forum-outline-rounded"),

  // Cloud
  row("cloud", "cloud-outline-rounded"),
  row("cloudOff", "cloud-off-outline-rounded"),
  row("cloudDownload", "cloud-download-outline-rounded"),
  row("cloudSync", "sync-outline-rounded"),

  // AI and automation
  row("robot", "smart-toy-outline-rounded"),
  row("sparkles", "wand-stars-outline-rounded"),
  row("tool", "build-outline-rounded"),
  row("stack", "stacks-outline-rounded"),
  row("bolt", "bolt-outline-rounded"),
  row("rocket", "rocket-launch-outline-rounded"),

  // Media and controls
  row("playerPlay", "play-arrow-outline-rounded"),
  row("playerStop", "stop-outline-rounded"),
  row("playerStopFilled", "stop-rounded", true),
  row("playerSkipForward", "skip-next-outline-rounded"),

  // Input
  row("keyboard", "keyboard-outline-rounded"),
  row("qrcode", "qr-code-outline-rounded"),
  row("target", "target-outline-rounded"),

  // Appearance
  row("palette", "palette-outline-rounded"),
  row("icons", "interests-outline-rounded"),
  row("photo", "image-outline-rounded"),

  // Devices
  row("deviceMobile", "mobile-outline-rounded"),

  // Misc
  row("hammer", "construction-outline-rounded"),
  row("bug", "bug-report-outline-rounded"),
  row("floppy", "save-outline-rounded"),

  // Markdown toolbar
  row("bold", "format-bold-outline-rounded"),
  row("italic", "format-italic-outline-rounded"),
  row("strikethrough", "format-strikethrough-outline-rounded"),
  row("heading1", "format-h1-outline-rounded"),
  row("heading2", "format-h2-outline-rounded"),
  row("link", "link-outline-rounded"),
  row("code", "code-outline-rounded"),
  row("list", "format-list-bulleted-outline-rounded"),
  row("listNumbers", "format-list-numbered-outline-rounded"),
  row("table", "table-outline-rounded"),
  row("quote", "format-quote-outline-rounded"),

  // Layout and chrome
  row("menu", "menu-outline-rounded"),
  row("splitHorizontal", "splitscreen-right-outline-rounded"),
  row("splitVertical", "splitscreen-bottom-outline-rounded"),
  row("ellipsis", "more-horiz-outline-rounded"),

  // Editing
  row("textCursor", "title-outline-rounded"),
]);
