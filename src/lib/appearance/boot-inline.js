/* Pre-paint appearance boot (spec 6.2), inlined into every HTML shell by the conduitAppearanceBoot() Vite
   plugin, which also replaces the two JSON placeholders. Plain ES5: it runs before any bundle loads.
   The migration mirrors migrate.ts and electron/services/appearance-migration.ts (parity-tested). */
(function () {
  var TABLE = __CONDUIT_MIGRATION_TABLE__;
  var SHELL_COLORS = __CONDUIT_SHELL_COLORS__;
  var KEYS = {
    theme: "conduit-theme",
    scheme: "conduit-color-scheme",
    iconPack: "conduit-icon-pack",
    version: "conduit-appearance-version"
  };
  // The mirrors of the retired settings keys (spec 6.1), removed at every boot.
  var RETIRED_KEYS = ["conduit-platform-theme", "conduit-density"];
  var root = document.documentElement;

  function warn(message, error) {
    if (window.console && console.warn) console.warn("[appearance boot] " + message, error);
  }

  function openStorage() {
    try {
      return window.localStorage;
    } catch (e) {
      warn("localStorage is not available", e);
      return null;
    }
  }

  function read(store, key) {
    if (!store) return null;
    try {
      return store.getItem(key);
    } catch (e) {
      warn("could not read " + key, e);
      return null;
    }
  }

  // A blocked storage only loses the mirror; the page still paints with the migrated values.
  function write(store, key, value) {
    if (!store) return;
    try {
      if (value === null) store.removeItem(key);
      else if (store.getItem(key) !== value) store.setItem(key, value);
    } catch (e) {
      warn("could not write " + key, e);
    }
  }

  function contains(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i] === value) return true;
    return false;
  }

  function pick(value, list, fallback) {
    return typeof value === "string" && contains(list, value) ? value : fallback;
  }

  function lookup(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
  }

  // max(2, the stored integer): a higher version was written by a later build and is never written back as 2.
  function keptVersion(value) {
    var stored = Number(value);
    return isFinite(stored) && Math.floor(stored) === stored && stored > TABLE.version ? stored : TABLE.version;
  }

  function retiredOr(scheme) {
    if (typeof scheme !== "string") return scheme;
    var retired = lookup(TABLE.retiredSchemes, scheme);
    return retired !== undefined ? retired : scheme;
  }

  function migrate(raw) {
    var d = TABLE.defaults;
    var theme = pick(raw.theme, TABLE.themes, d.theme);
    var version = keptVersion(raw.appearance_version);
    if (Number(raw.appearance_version) >= TABLE.version) {
      return {
        version: version,
        color_scheme: pick(retiredOr(raw.color_scheme), TABLE.schemes, d.color_scheme),
        icon_pack: pick(raw.icon_pack, TABLE.iconPacks, d.icon_pack),
        theme: theme
      };
    }
    var platform = typeof raw.platform_theme === "string" ? raw.platform_theme : TABLE.legacy.platform_theme;
    var scheme = typeof raw.color_scheme === "string" ? raw.color_scheme : TABLE.legacy.color_scheme;
    var untouchedDefault = platform === TABLE.legacy.platform_theme && scheme === TABLE.legacy.color_scheme;
    var retired = lookup(TABLE.retiredSchemes, scheme);
    var next = retired !== undefined ? retired : untouchedDefault ? d.color_scheme : scheme;
    var platformPack = lookup(TABLE.packByPlatform, platform);
    return {
      version: version,
      color_scheme: pick(next, TABLE.schemes, d.color_scheme),
      icon_pack: pick(raw.icon_pack, TABLE.iconPacks, platformPack !== undefined ? platformPack : d.icon_pack),
      theme: theme
    };
  }

  function prefersDark() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (e) {
      warn("could not read the system color scheme", e);
      return false;
    }
  }

  function detectOs() {
    var bridge = window.electron;
    var platform = bridge && typeof bridge.platform === "string" ? bridge.platform : "";
    if (platform === "darwin") return "macos";
    if (platform === "win32") return "windows";
    if (platform) return "linux";
    var agent = navigator.userAgent || "";
    if (/Mac/.test(agent)) return "macos";
    if (/Win/.test(agent)) return "windows";
    return "linux";
  }

  var store = openStorage();
  var result = migrate({
    appearance_version: read(store, KEYS.version),
    platform_theme: read(store, RETIRED_KEYS[0]),
    color_scheme: read(store, KEYS.scheme),
    icon_pack: read(store, KEYS.iconPack),
    theme: read(store, KEYS.theme)
  });
  write(store, KEYS.scheme, result.color_scheme);
  write(store, KEYS.iconPack, result.icon_pack);
  write(store, KEYS.theme, result.theme);
  write(store, KEYS.version, String(result.version));
  for (var r = 0; r < RETIRED_KEYS.length; r++) write(store, RETIRED_KEYS[r], null);

  var mode = result.theme === "dark" || (result.theme === "system" && prefersDark()) ? "dark" : "light";
  var colors = SHELL_COLORS[result.color_scheme][mode];

  root.classList.remove("dark", "light");
  root.classList.add(mode);
  root.setAttribute("data-scheme", result.color_scheme);
  root.setAttribute("data-os", detectOs());
  root.style.setProperty("--c-boot-bg", colors.shell);
  root.style.setProperty("--c-boot-fg", colors.fg);
})();
