import { beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { APPEARANCE_KEYS, migrateAppearance, migrateAppearanceStorage, type RawAppearance } from "../migrate";

const LEGACY_PLATFORM_KEY = "conduit-platform-theme";

describe("migrateAppearance: the spec 6.3 table", () => {
  const rows: Array<[string, RawAppearance, string, string]> = [
    ["untouched default", { platform_theme: "default", color_scheme: "ocean" }, "modern", "codicons"],
    ["missing platform and scheme", {}, "modern", "codicons"],
    ["default platform, missing scheme", { platform_theme: "default" }, "modern", "codicons"],
    ["missing platform, ocean", { color_scheme: "ocean" }, "modern", "codicons"],
    ["default + ember", { platform_theme: "default", color_scheme: "ember" }, "ember", "codicons"],
    ["default + forest", { platform_theme: "default", color_scheme: "forest" }, "forest", "codicons"],
    ["default + amethyst", { platform_theme: "default", color_scheme: "amethyst" }, "amethyst", "codicons"],
    ["default + rose", { platform_theme: "default", color_scheme: "rose" }, "rose", "codicons"],
    ["default + midnight", { platform_theme: "default", color_scheme: "midnight" }, "midnight", "codicons"],
    ["macos + macos-blue", { platform_theme: "macos", color_scheme: "macos-blue" }, "modern", "phosphor"],
    ["macos + macos-graphite", { platform_theme: "macos", color_scheme: "macos-graphite" }, "modern", "phosphor"],
    ["windows + win-blue", { platform_theme: "windows", color_scheme: "win-blue" }, "modern", "fluent"],
    ["windows + win-sun-valley", { platform_theme: "windows", color_scheme: "win-sun-valley" }, "modern", "fluent"],
    ["ubuntu + ubuntu-yaru", { platform_theme: "ubuntu", color_scheme: "ubuntu-yaru" }, "ember", "tabler"],
    ["ubuntu + ubuntu-gnome", { platform_theme: "ubuntu", color_scheme: "ubuntu-gnome" }, "modern", "tabler"],
    ["macos keeps ocean", { platform_theme: "macos", color_scheme: "ocean" }, "ocean", "phosphor"],
    ["windows keeps rose", { platform_theme: "windows", color_scheme: "rose" }, "rose", "fluent"],
    ["ubuntu keeps midnight", { platform_theme: "ubuntu", color_scheme: "midnight" }, "midnight", "tabler"],
    ["macos with missing scheme keeps ocean", { platform_theme: "macos" }, "ocean", "phosphor"],
    ["windows + a stale macOS scheme", { platform_theme: "windows", color_scheme: "macos-graphite" }, "modern", "fluent"],
    ["ubuntu + a stale Windows scheme", { platform_theme: "ubuntu", color_scheme: "win-blue" }, "modern", "tabler"],
    ["default + a stale Ubuntu scheme", { platform_theme: "default", color_scheme: "ubuntu-yaru" }, "ember", "codicons"],
    ["an unknown scheme becomes modern", { platform_theme: "default", color_scheme: "sepia" }, "modern", "codicons"],
    ["a saved pack wins over the platform", { platform_theme: "macos", color_scheme: "ocean", icon_pack: "lucide" }, "ocean", "lucide"],
    ["an unknown saved pack falls back to the platform", { platform_theme: "windows", icon_pack: "emoji" }, "ocean", "fluent"],
  ];

  it.each(rows)("%s", (_label, raw, scheme, pack) => {
    expect(migrateAppearance(raw)).toEqual({ appearance_version: 2, color_scheme: scheme, icon_pack: pack, ui_density: "comfortable" });
  });

  it("keeps a valid density and resets an unknown one", () => {
    expect(migrateAppearance({ ui_density: "compact" }).ui_density).toBe("compact");
    expect(migrateAppearance({ ui_density: "roomy" }).ui_density).toBe("comfortable");
  });

  it("version 2 only validates: nothing is remapped", () => {
    const raw = { appearance_version: 2, platform_theme: "macos", color_scheme: "ocean", icon_pack: "tabler", ui_density: "compact" };
    expect(migrateAppearance(raw)).toEqual({ appearance_version: 2, color_scheme: "ocean", icon_pack: "tabler", ui_density: "compact" });
    expect(migrateAppearance({ appearance_version: "2", color_scheme: "macos-blue", icon_pack: "nope", ui_density: "x" })).toEqual({
      appearance_version: 2,
      color_scheme: "modern",
      icon_pack: "codicons",
      ui_density: "comfortable",
    });
    expect(migrateAppearance({ appearance_version: 3 }).color_scheme).toBe("modern");
  });

  it("keeps a newer version a later build wrote, so its migration does not run again", () => {
    expect(migrateAppearance({ appearance_version: "3", color_scheme: "ember", icon_pack: "lucide" })).toEqual({
      appearance_version: 3,
      color_scheme: "ember",
      icon_pack: "lucide",
      ui_density: "comfortable",
    });
    expect(migrateAppearance({ appearance_version: "2.5" }).appearance_version).toBe(2);
    expect(migrateAppearance({ appearance_version: "1" }).appearance_version).toBe(2);
  });

  it("is idempotent", () => {
    const text = fc.option(fc.oneof(fc.constantFrom("default", "macos", "windows", "ubuntu", "ocean", "modern", "ember", "macos-blue", "ubuntu-yaru", "codicons", "fluent", "compact", "2", "1"), fc.string()), { nil: null });
    fc.assert(
      fc.property(fc.record({ appearance_version: text, platform_theme: text, color_scheme: text, icon_pack: text, ui_density: text }), (raw) => {
        const once = migrateAppearance(raw);
        expect(migrateAppearance(once)).toEqual(once);
      }),
    );
  });
});

describe("migrateAppearanceStorage", () => {
  beforeEach(() => localStorage.clear());

  it("migrates the localStorage mirror and removes the platform key", () => {
    localStorage.setItem(LEGACY_PLATFORM_KEY, "ubuntu");
    localStorage.setItem(APPEARANCE_KEYS.scheme, "ubuntu-yaru");
    localStorage.setItem(APPEARANCE_KEYS.theme, "light");
    const result = migrateAppearanceStorage(localStorage);
    expect(result).toEqual({ appearance_version: 2, color_scheme: "ember", icon_pack: "tabler", ui_density: "comfortable" });
    expect(localStorage.getItem(LEGACY_PLATFORM_KEY)).toBeNull();
    expect(localStorage.getItem(APPEARANCE_KEYS.scheme)).toBe("ember");
    expect(localStorage.getItem(APPEARANCE_KEYS.iconPack)).toBe("tabler");
    expect(localStorage.getItem(APPEARANCE_KEYS.density)).toBe("comfortable");
    expect(localStorage.getItem(APPEARANCE_KEYS.version)).toBe("2");
    expect(localStorage.getItem(APPEARANCE_KEYS.theme)).toBe("light");
  });

  it("an empty storage (fresh install) gets Modern and Codicons", () => {
    expect(migrateAppearanceStorage(localStorage)).toEqual({ appearance_version: 2, color_scheme: "modern", icon_pack: "codicons", ui_density: "comfortable" });
  });

  it("never writes a newer stored version back down to 2", () => {
    localStorage.setItem(APPEARANCE_KEYS.version, "3");
    localStorage.setItem(APPEARANCE_KEYS.scheme, "rose");
    expect(migrateAppearanceStorage(localStorage).appearance_version).toBe(3);
    expect(localStorage.getItem(APPEARANCE_KEYS.version)).toBe("3");
  });

  it("a second run changes nothing", () => {
    localStorage.setItem(LEGACY_PLATFORM_KEY, "macos");
    localStorage.setItem(APPEARANCE_KEYS.scheme, "rose");
    const first = migrateAppearanceStorage(localStorage);
    const snapshot = { ...localStorage };
    expect(migrateAppearanceStorage(localStorage)).toEqual(first);
    expect({ ...localStorage }).toEqual(snapshot);
  });

  it("works without storage (blocked or missing) and returns the defaults", () => {
    expect(migrateAppearanceStorage(null).color_scheme).toBe("modern");
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(migrateAppearanceStorage(throwing)).toEqual({ appearance_version: 2, color_scheme: "modern", icon_pack: "codicons", ui_density: "comfortable" });
  });
});
