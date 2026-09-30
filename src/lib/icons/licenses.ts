import { ICON_PACKS, type IconPackId, type IconPackInfo } from "./types";

export interface IconPackLicense extends IconPackInfo {
  copyright: string;
  /** The pack's attribution line, as written in the shipped license file (spec 5.9). */
  notice: string;
}

/** Served from public/ and copied to dist/ by Vite; fetch it relative to the page. */
export const THIRD_PARTY_ICON_LICENSES_PATH = "./licenses/third-party-icons.txt";

const ATTRIBUTION: Readonly<Record<IconPackId, Pick<IconPackLicense, "copyright" | "notice">>> = {
  lucide: {
    copyright: "© Lucide Icons and Contributors; portions © Cole Bemis (Feather)",
    notice: "Lucide © Lucide Icons and Contributors, licensed under ISC. Portions © Cole Bemis (Feather), licensed under MIT.",
  },
  phosphor: {
    copyright: "© Phosphor Icons",
    notice: "Phosphor Icons © Phosphor Icons, licensed under MIT.",
  },
  hugeicons: {
    copyright: "© Hugeicons",
    notice: "Hugeicons Free © Hugeicons, licensed under MIT.",
  },
  material: {
    copyright: "© Google",
    notice: "Material Symbols © Google, licensed under Apache 2.0. Converted from SVG to React path data.",
  },
  fluent: {
    copyright: "© Microsoft Corporation",
    notice: "Fluent UI System Icons © Microsoft Corporation, licensed under MIT.",
  },
  tabler: {
    copyright: "© Paweł Kuna",
    notice: "Tabler Icons © Paweł Kuna, licensed under MIT.",
  },
};

export const ICON_PACK_LICENSES: ReadonlyArray<IconPackLicense> = Object.freeze(
  ICON_PACKS.map((pack) => ({ ...pack, ...ATTRIBUTION[pack.id] })),
);
