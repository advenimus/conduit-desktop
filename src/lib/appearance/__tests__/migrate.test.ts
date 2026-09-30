import { beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { APPEARANCE_KEYS, RETIRED_STORAGE_KEYS, migrateAppearance, migrateAppearanceStorage, type RawAppearance } from "../migrate";

describe("migrateAppearance: the spec 6.3 table", () => {
  const rows: Array<[string, RawAppearance, string, string]> = [
    ["untouched default", { platform_theme: "default", color_scheme: "ocean" }, "modern", "lucide"],
    ["missing platform and scheme", {}, "modern", "lucide"],
    ["default platform, missing scheme", { platform_theme: "default" }, "modern", "lucide"],
    ["missing platform, ocean", { color_scheme: "ocean" }, "modern", "lucide"],
    ["default + ember", { platform_theme: "default", color_scheme: "ember" }, "ember", "lucide"],
    ["default + forest", { platform_theme: "default", color_scheme: "forest" }, "forest", "lucide"],
    ["default + amethyst", { platform_theme: "default", color_scheme: "amethyst" }, "amethyst", "lucide"],
    ["default + rose", { platform_theme: "default", color_scheme: "rose" }, "rose", "lucide"],
    ["default + midnight", { platform_theme: "default", color_scheme: "midnight" }, "midnight", "lucide"],
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
    ["default + a stale Ubuntu scheme", { platform_theme: "default", color_scheme: "ubuntu-yaru" }, "ember", "lucide"],
    ["an unknown scheme becomes modern", { platform_theme: "default", color_scheme: "sepia" }, "modern", "lucide"],
    ["a saved pack wins over the platform", { platform_theme: "macos", color_scheme: "ocean", icon_pack: "hugeicons" }, "ocean", "hugeicons"],
    ["an unknown saved pack falls back to the platform", { platform_theme: "windows", icon_pack: "emoji" }, "ocean", "fluent"],
    ["a saved codicons falls back to the platform", { platform_theme: "ubuntu", icon_pack: "codicons" }, "ocean", "tabler"],
  ];

  it.each(rows)("%s", (_label, raw, scheme, pack) => {
    expect(migrateAppearance(raw)).toEqual({ appearance_version: 2, color_scheme: scheme, icon_pack: pack, theme: "system" });
  });

  it("version 2 validates: retired schemes map, unknown values fall back, nothing else is remapped", () => {
    const raw = { appearance_version: 2, platform_theme: "macos", color_scheme: "ocean", icon_pack: "tabler", theme: "dark" };
    expect(migrateAppearance(raw)).toEqual({ appearance_version: 2, color_scheme: "ocean", icon_pack: "tabler", theme: "dark" });
    expect(migrateAppearance({ appearance_version: "2", color_scheme: "sepia", icon_pack: "nope", theme: "dim" })).toEqual({
      appearance_version: 2,
      color_scheme: "modern",
      icon_pack: "lucide",
      theme: "system",
    });
  });

  it("version 2 with codicons (a wave-1 development profile) gets Lucide (D-14)", () => {
    expect(migrateAppearance({ appearance_version: 2, color_scheme: "rose", icon_pack: "codicons" })).toMatchObject({ color_scheme: "rose", icon_pack: "lucide" });
  });

  it("version 2 with a retired scheme (a released build wrote it after a downgrade) maps it (rule 2)", () => {
    expect(migrateAppearance({ appearance_version: 2, color_scheme: "ubuntu-yaru", icon_pack: "fluent" })).toMatchObject({ color_scheme: "ember", icon_pack: "fluent" });
    expect(migrateAppearance({ appearance_version: 2, color_scheme: "win-blue" }).color_scheme).toBe("modern");
  });

  it("an invalid theme becomes system in both branches (rule 4)", () => {
    expect(migrateAppearance({ theme: "bogus", platform_theme: "macos", color_scheme: "macos-blue" })).toMatchObject({ theme: "system", icon_pack: "phosphor" });
    expect(migrateAppearance({ appearance_version: 2, theme: "bogus" }).theme).toBe("system");
    expect(migrateAppearance({ theme: "light" }).theme).toBe("light");
  });

  it("keeps a newer version a later build wrote and validates its values (rule 5)", () => {
    expect(migrateAppearance({ appearance_version: "3", color_scheme: "ember", icon_pack: "hugeicons", theme: "dark" })).toEqual({
      appearance_version: 3,
      color_scheme: "ember",
      icon_pack: "hugeicons",
      theme: "dark",
    });
    expect(migrateAppearance({ appearance_version: 3, color_scheme: "nope", icon_pack: "codicons" })).toMatchObject({ appearance_version: 3, color_scheme: "modern", icon_pack: "lucide" });
    expect(migrateAppearance({ appearance_version: "2.5" }).appearance_version).toBe(2);
    expect(migrateAppearance({ appearance_version: "1" }).appearance_version).toBe(2);
  });

  it("is idempotent", () => {
    const text = fc.option(
      fc.oneof(
        fc.constantFrom("default", "macos", "windows", "ubuntu", "ocean", "modern", "ember", "macos-blue", "ubuntu-yaru", "win-blue", "codicons", "hugeicons", "fluent", "dark", "system", "bogus", "2", "1", "3"),
        fc.string(),
      ),
      { nil: null },
    );
    fc.assert(
      fc.property(fc.record({ appearance_version: text, platform_theme: text, color_scheme: text, icon_pack: text, theme: text }), (raw) => {
        const once = migrateAppearance(raw);
        expect(migrateAppearance(once)).toEqual(once);
      }),
    );
  });
});

describe("migrateAppearanceStorage", () => {
  beforeEach(() => localStorage.clear());

  it("migrates the localStorage mirror and removes the retired keys", () => {
    localStorage.setItem(RETIRED_STORAGE_KEYS.platform, "ubuntu");
    localStorage.setItem(RETIRED_STORAGE_KEYS.density, "compact");
    localStorage.setItem(APPEARANCE_KEYS.scheme, "ubuntu-yaru");
    localStorage.setItem(APPEARANCE_KEYS.theme, "light");
    const result = migrateAppearanceStorage(localStorage);
    expect(result).toEqual({ appearance_version: 2, color_scheme: "ember", icon_pack: "tabler", theme: "light" });
    expect(localStorage.getItem("conduit-platform-theme")).toBeNull();
    expect(localStorage.getItem("conduit-density")).toBeNull();
    expect(localStorage.getItem(APPEARANCE_KEYS.scheme)).toBe("ember");
    expect(localStorage.getItem(APPEARANCE_KEYS.iconPack)).toBe("tabler");
    expect(localStorage.getItem(APPEARANCE_KEYS.version)).toBe("2");
    expect(localStorage.getItem(APPEARANCE_KEYS.theme)).toBe("light");
  });

  it("an empty storage (fresh install) gets Modern, Lucide and the system theme", () => {
    expect(migrateAppearanceStorage(localStorage)).toEqual({ appearance_version: 2, color_scheme: "modern", icon_pack: "lucide", theme: "system" });
    expect(localStorage.getItem(APPEARANCE_KEYS.iconPack)).toBe("lucide");
  });

  it("repairs an invalid stored theme", () => {
    localStorage.setItem(APPEARANCE_KEYS.theme, "sepia");
    expect(migrateAppearanceStorage(localStorage).theme).toBe("system");
    expect(localStorage.getItem(APPEARANCE_KEYS.theme)).toBe("system");
  });

  it("never writes a newer stored version back down to 2", () => {
    localStorage.setItem(APPEARANCE_KEYS.version, "3");
    localStorage.setItem(APPEARANCE_KEYS.scheme, "rose");
    expect(migrateAppearanceStorage(localStorage).appearance_version).toBe(3);
    expect(localStorage.getItem(APPEARANCE_KEYS.version)).toBe("3");
  });

  it("a second run changes nothing", () => {
    localStorage.setItem(RETIRED_STORAGE_KEYS.platform, "macos");
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
    expect(migrateAppearanceStorage(throwing)).toEqual({ appearance_version: 2, color_scheme: "modern", icon_pack: "lucide", theme: "system" });
  });
});
