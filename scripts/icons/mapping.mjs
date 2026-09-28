// Semantic name -> Iconify glyphs (spec Appendix A.1, A.3). `codicon: null`: no
// Codicon exists, so packs/codicons.tsx renders a Lucide icon instead.

const row = (name, codicon, codiconCompact, material, materialFill = false) =>
  Object.freeze({ name, codicon, codiconCompact, material, materialFill });

export const ICON_MAPPING = Object.freeze([
  // Actions
  row("close", "close", "close-compact", "close-outline-rounded"),
  row("plus", "add", "add-compact", "add-outline-rounded"),
  row("check", "check", "check-compact", "check-outline-rounded"),
  row("search", "search", "search-compact", "search-outline-rounded"),
  row("trash", "trash", null, "delete-outline-rounded"),
  row("pencil", "edit", "edit-compact", "edit-outline-rounded"),
  row("copy", "copy", null, "content-copy-outline-rounded"),
  row("refresh", "refresh", "refresh-compact", "refresh-outline-rounded"),
  row("send", "send", null, "send-outline-rounded"),
  row("download", "download", null, "download-outline-rounded"),
  row("upload", "cloud-upload", "cloud-upload-compact", "upload-outline-rounded"),
  row("externalLink", "link-external", null, "open-in-new-outline-rounded"),
  row("login", "sign-in", null, "login-outline-rounded"),
  row("logout", "sign-out", null, "logout-outline-rounded"),
  row("restore", "discard", null, "settings-backup-restore-outline-rounded"),
  row("settings", "settings-gear", null, "settings-outline-rounded"),
  row("eye", "eye", null, "visibility-outline-rounded"),
  row("eyeOff", "eye-closed", null, "visibility-off-outline-rounded"),

  // Navigation
  row("home", "home", null, "home-outline-rounded"),
  row("arrowLeft", "arrow-left", null, "arrow-back-outline-rounded"),
  row("arrowRight", "arrow-right", null, "arrow-forward-outline-rounded"),
  row("arrowUp", "arrow-up", "arrow-up-compact", "arrow-upward-outline-rounded"),
  row("arrowsExchange", "arrow-swap", null, "swap-horiz-outline-rounded"),
  row("chevronDown", "chevron-down", "chevron-down-compact", "keyboard-arrow-down-outline-rounded"),
  row("chevronLeft", "chevron-left", "chevron-left-compact", "chevron-left-outline-rounded"),
  row("chevronRight", "chevron-right", "chevron-right-compact", "chevron-right-outline-rounded"),

  // Status
  row("alertCircle", "error", "error-compact", "error-outline-rounded"),
  row("alertTriangle", "warning", "warning-compact", "warning-outline-rounded"),
  row("infoCircle", "info", null, "info-outline-rounded"),
  row("circleCheck", "pass", "pass-compact", "check-circle-outline-rounded"),
  row("circleX", "error", "error-compact", "cancel-outline-rounded"),
  row("ban", "circle-slash", "circle-slash-compact", "block-outline-rounded"),
  row("loader", "loading", "loading-compact", "progress-activity-outline-rounded"),
  row("wifiOff", "debug-disconnect", "debug-disconnect-compact", "wifi-off-outline-rounded"),

  // Security
  row("lock", "lock", null, "lock-outline-rounded"),
  row("lockOpen", "unlock", null, "lock-open-outline-rounded"),
  row("key", "key", null, "key-outline-rounded"),
  row("shield", "shield", "shield-compact", "shield-outline-rounded"),
  row("shieldCheck", "workspace-trusted", null, "verified-user-outline-rounded"),
  row("shieldLock", "shield", "shield-compact", "shield-lock-outline-rounded"),
  row("fingerprint", null, null, "fingerprint-outline-rounded"),

  // Files and folders
  row("file", "file", null, "draft-outline-rounded"),
  row("fileCode", "file-code", null, "code-blocks-outline-rounded"),
  row("fileImport", "go-to-file", null, "file-open-outline-rounded"),
  row("filePlus", "new-file", null, "note-add-outline-rounded"),
  row("fileText", "file-text", null, "description-outline-rounded"),
  row("fileX", null, null, "file-copy-off-outline-rounded"),
  row("folder", "folder", "folder-compact", "folder-outline-rounded"),
  row("folderOpen", "folder-opened", "folder-opened-compact", "folder-open-outline-rounded"),
  row("folderPlus", "new-folder", null, "create-new-folder-outline-rounded"),

  // People
  row("user", "person", null, "person-outline-rounded"),
  row("users", "organization", null, "group-outline-rounded"),
  row("crown", null, null, "crown-outline-rounded"),

  // Connection types
  row("terminal", "terminal", "terminal-compact", "terminal-outline-rounded"),
  row("terminalAlt", "terminal", "terminal-compact", "terminal-2-outline-rounded"),
  row("desktop", "vm", "vm-compact", "desktop-windows-outline-rounded"),
  row("globe", "globe", null, "language-outline-rounded"),
  row("globeWww", "browser", null, "globe-outline-rounded"),
  row("server", "server", null, "dns-outline-rounded"),
  row("serverAlt", "server-environment", null, "storage-outline-rounded"),
  row("devices", "multiple-windows", null, "devices-outline-rounded"),
  row("network", "type-hierarchy", null, "lan-outline-rounded"),
  row("plug", "plug", null, "power-plug-outline-rounded"),
  row("plugDisconnected", "debug-disconnect", "debug-disconnect-compact", "power-plug-off-outline-rounded"),

  // Favorites
  row("star", "star-empty", null, "star-outline-rounded"),
  row("starFilled", "star-full", null, "star-rounded", true),
  row("pin", "pin", null, "keep-outline-rounded"),
  row("pinFilled", "pinned", null, "keep-rounded", true),

  // Data
  row("database", "database", null, "database-outline-rounded"),
  row("history", "history", null, "history-outline-rounded"),
  row("calendar", "calendar", null, "calendar-today-outline-rounded"),
  row("clock", "clockface", null, "schedule-outline-rounded"),
  row("tag", "tag", null, "sell-outline-rounded"),
  row("notes", "note", null, "sticky-note-2-outline-rounded"),

  // Communication
  row("mail", "mail", null, "mail-outline-rounded"),
  row("message", "comment", "comment-compact", "chat-bubble-outline-rounded"),
  row("messageChatbot", "comment-discussion-sparkle", null, "forum-outline-rounded"),

  // Cloud
  row("cloud", "cloud", "cloud-compact", "cloud-outline-rounded"),
  row("cloudOff", null, null, "cloud-off-outline-rounded"),
  row("cloudDownload", "cloud-download", "cloud-download-compact", "cloud-download-outline-rounded"),

  // AI and automation
  row("robot", "robot", null, "smart-toy-outline-rounded"),
  row("sparkles", "sparkle", "sparkle-compact", "wand-stars-outline-rounded"),
  row("tool", "tools", null, "build-outline-rounded"),
  row("stack", "layers", null, "stacks-outline-rounded"),
  row("bolt", null, null, "bolt-outline-rounded"),
  row("rocket", "rocket", "rocket-compact", "rocket-launch-outline-rounded"),

  // Media and controls
  row("playerPlay", "play", null, "play-arrow-outline-rounded"),
  row("playerStop", "debug-stop", null, "stop-outline-rounded"),
  row("playerStopFilled", "stop-circle", null, "stop-rounded", true),
  row("playerSkipForward", "debug-step-over", null, "skip-next-outline-rounded"),

  // Input
  row("keyboard", "record-keys", "record-keys-compact", "keyboard-outline-rounded"),
  row("qrcode", null, null, "qr-code-outline-rounded"),
  row("target", "target", null, "target-outline-rounded"),

  // Appearance
  row("palette", "symbol-color", "symbol-color-compact", "palette-outline-rounded"),
  row("icons", "extensions", null, "interests-outline-rounded"),
  row("photo", "file-media", "file-media-compact", "image-outline-rounded"),

  // Devices
  row("deviceMobile", "device-mobile", null, "mobile-outline-rounded"),

  // Misc
  row("hammer", "tools", null, "construction-outline-rounded"),
  row("bug", "bug", null, "bug-report-outline-rounded"),
  row("floppy", "save", null, "save-outline-rounded"),

  // Markdown toolbar
  row("bold", "bold", null, "format-bold-outline-rounded"),
  row("italic", "italic", null, "format-italic-outline-rounded"),
  row("strikethrough", "strikethrough", null, "format-strikethrough-outline-rounded"),
  row("heading1", null, null, "format-h1-outline-rounded"),
  row("heading2", null, null, "format-h2-outline-rounded"),
  row("link", "link", null, "link-outline-rounded"),
  row("code", "code", null, "code-outline-rounded"),
  row("list", "list-unordered", null, "format-list-bulleted-outline-rounded"),
  row("listNumbers", "list-ordered", null, "format-list-numbered-outline-rounded"),
  row("table", "table", null, "table-outline-rounded"),
  row("quote", "quote", null, "format-quote-outline-rounded"),

  // Layout and chrome
  row("menu", "menu", null, "menu-outline-rounded"),
  row("panelLeft", "layout-sidebar-left", null, "left-panel-close-outline-rounded"),
  row("panelLeftOff", "layout-sidebar-left-off", null, "left-panel-open-outline-rounded"),
  row("panelRight", "layout-sidebar-right", null, "right-panel-close-outline-rounded"),
  row("panelRightOff", "layout-sidebar-right-off", null, "right-panel-open-outline-rounded"),
  row("splitHorizontal", "split-horizontal", null, "splitscreen-right-outline-rounded"),
  row("splitVertical", "split-vertical", null, "splitscreen-bottom-outline-rounded"),
  row("ellipsis", "ellipsis", null, "more-horiz-outline-rounded"),
  row("collapseAll", "collapse-all", "collapse-all-compact", "unfold-less-outline-rounded"),
  row("account", "account", null, "account-circle-outline-rounded"),
  row("explorer", "files", null, "files-outline-rounded"),
  row("circleFilled", "circle-filled", "circle-filled-compact", "circle-rounded", true),
]);
