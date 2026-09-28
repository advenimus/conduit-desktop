import { Icon, ICON_PACKS, type SemanticIconName } from "../../../lib/icons";
import { Demo, GallerySection } from "./Section";

// The Appearance tab's preview strip (spec 5.7), then the 12 layout and chrome names (5.3).
const PREVIEW: ReadonlyArray<SemanticIconName> = ["folder", "terminal", "desktop", "globe", "key", "search", "settings", "cloud"];
const CHROME: ReadonlyArray<SemanticIconName> = [
  "menu",
  "panelLeft",
  "panelLeftOff",
  "panelRight",
  "panelRightOff",
  "splitHorizontal",
  "splitVertical",
  "ellipsis",
  "collapseAll",
  "account",
  "explorer",
  "circleFilled",
];
const COMPACT: ReadonlyArray<SemanticIconName> = ["close", "plus", "chevronDown", "folder", "circleFilled", "arrowUp"];

function IconCell({ name, pack }: { name: SemanticIconName; pack: (typeof ICON_PACKS)[number]["id"] }) {
  return (
    <span className="flex size-6 items-center justify-center text-ink-secondary" title={name}>
      <Icon name={name} pack={pack} size={16} />
    </span>
  );
}

export function IconsSection() {
  return (
    <GallerySection id="icons" title="Icon packs">
      <Demo label="Every pack at 16px: preview strip, then layout and chrome names (splitHorizontal = Split Right, side-by-side panes; splitVertical = Split Down)" className="block">
        <table className="border-separate border-spacing-x-1 border-spacing-y-1 text-left">
          <thead>
            <tr className="h-24 text-meta text-ink-muted">
              <th className="pr-3 font-semibold">Pack</th>
              {[...PREVIEW, ...CHROME].map((name) => (
                <th key={name} className="w-6 align-bottom font-normal">
                  <span className="block max-w-6 origin-bottom-left -rotate-45 whitespace-nowrap pb-1">{name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ICON_PACKS.map((pack) => (
              <tr key={pack.id}>
                <td className="whitespace-nowrap pr-3 text-label font-semibold text-ink">{pack.label}</td>
                {[...PREVIEW, ...CHROME].map((name) => (
                  <td key={name}>
                    <IconCell name={name} pack={pack.id} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Demo>
      <Demo label="Codicons compact glyphs: 12px compact, then 16px">
        {COMPACT.map((name) => (
          <span key={name} className="flex items-center gap-1 text-ink-secondary" title={name}>
            <Icon name={name} size={12} compact />
            <Icon name={name} size={16} />
          </span>
        ))}
      </Demo>
    </GallerySection>
  );
}
