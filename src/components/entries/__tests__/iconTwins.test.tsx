import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { ComponentType } from "react";
import { mapping as tablerMapping } from "../../../lib/icons/packs/tabler";
import { getPackMapping } from "../../../lib/icons/pack-cache";
import { setIconPack } from "../../../lib/icons/store";
import { ServerIcon, type IconComponent, type SemanticIconName } from "../../../lib/icons";
import { CUSTOM_ICON_TWINS, ICON_CATEGORIES, ICON_MAP, resolveIcon } from "../iconRegistry";
import { getEntryIcon } from "../entryIcons";

const TABLER_PACK_STROKE = 1.5;

function svgBody(Icon: ComponentType<{ size?: number; stroke?: number }>, stroke?: number): string {
  const { container, unmount } = render(<Icon size={16} stroke={stroke} />);
  const svg = container.querySelector("svg");
  const body = svg?.innerHTML ?? "";
  unmount();
  return body;
}

const curatedNames = ICON_CATEGORIES.flatMap((c) => c.icons.map((i) => i.name));

afterEach(async () => {
  await setIconPack("lucide");
});

describe("custom icon twins (spec 5.11)", () => {
  it("lists 65 curated names, 30 of them with a semantic twin", () => {
    expect(curatedNames).toHaveLength(65);
    expect(new Set(curatedNames).size).toBe(65);
    expect(Object.keys(CUSTOM_ICON_TWINS)).toHaveLength(30);
  });

  it("every twin is a curated name", () => {
    for (const name of Object.keys(CUSTOM_ICON_TWINS)) expect(ICON_MAP.has(name), name).toBe(true);
  });

  it("every twin equals the Tabler pack's own mapping of its semantic name", () => {
    for (const [name, semantic] of Object.entries(CUSTOM_ICON_TWINS)) {
      const curated = ICON_MAP.get(name)!;
      expect(svgBody(tablerMapping[semantic as SemanticIconName]), name).toBe(svgBody(curated, TABLER_PACK_STROKE));
    }
  });

  it("no curated name outside the table has a twin in the Tabler pack", () => {
    const packBodies = new Set(Object.values(tablerMapping).map((Icon) => svgBody(Icon)));
    const others = curatedNames.filter((name) => !(name in CUSTOM_ICON_TWINS));
    expect(others).toHaveLength(35);
    for (const name of others) expect(packBodies.has(svgBody(ICON_MAP.get(name)!, TABLER_PACK_STROKE)), name).toBe(false);
  });

  it("a twin resolves to the named themed component, the others to a Tabler glyph", () => {
    expect(resolveIcon("IconServer")).toBe(ServerIcon);
    expect(getEntryIcon("ssh", false, "IconServer")).toBe(ServerIcon);
    const docker = resolveIcon("IconBrandDocker") as IconComponent;
    expect(svgBody(docker)).toBe(svgBody(ICON_MAP.get("IconBrandDocker")!));
    expect(resolveIcon("IconUnknown")).toBeNull();
    expect(resolveIcon(null)).toBeNull();
  });

  it("with Hugeicons active a twin draws the Hugeicons glyph and a brand icon stays Tabler", async () => {
    await setIconPack("hugeicons");
    const hugeicons = getPackMapping("hugeicons");
    expect(hugeicons).not.toBeNull();
    expect(svgBody(getEntryIcon("ssh", false, "IconServer"))).toBe(svgBody(hugeicons!.server));
    expect(svgBody(getEntryIcon("ssh", false, "IconServer"))).not.toBe(svgBody(ICON_MAP.get("IconServer")!, TABLER_PACK_STROKE));
    expect(svgBody(getEntryIcon("ssh", false, "IconBrandDocker"))).toBe(svgBody(ICON_MAP.get("IconBrandDocker")!));
    for (const [name, semantic] of Object.entries(CUSTOM_ICON_TWINS)) {
      expect(svgBody(resolveIcon(name)!), name).toBe(svgBody(hugeicons![semantic as SemanticIconName]));
    }
  });
});
