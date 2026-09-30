import { Icon, ICON_PACKS, SEMANTIC_ICON_NAMES, type IconPackId, type SemanticIconName } from "../../../lib/icons";
import { Demo, GallerySection } from "./Section";

// The Appearance tab's preview strip (spec 5.8), then the layout names the pane tab bars use (5.1).
const PREVIEW: ReadonlyArray<SemanticIconName> = ["folder", "terminal", "desktop", "globe", "key", "search", "settings", "cloud"];
const LAYOUT: ReadonlyArray<SemanticIconName> = ["menu", "splitHorizontal", "splitVertical", "ellipsis", "circleFilled"];
const STATES = [
  ["Connected", "text-(--c-state-connected)"],
  ["Connecting", "text-(--c-state-connecting)"],
  ["Disconnected", "text-(--c-state-error)"],
] as const;

function IconCell({ name, pack }: { name: SemanticIconName; pack: IconPackId }) {
  return (
    <span className="flex size-6 items-center justify-center text-ink-secondary" title={name}>
      <Icon name={name} pack={pack} size={16} />
    </span>
  );
}

export function IconsSection() {
  return (
    <GallerySection id="icons" title="Icon packs">
      <Demo label="Every pack at 16px: the Appearance preview strip, then the layout names (splitHorizontal = Split Right, side-by-side panes; splitVertical = Split Down)" className="block">
        <table className="border-separate border-spacing-x-1 border-spacing-y-1 text-left">
          <thead>
            <tr className="h-24 text-meta text-ink-muted">
              <th className="pr-3 font-semibold">Pack</th>
              {[...PREVIEW, ...LAYOUT].map((name) => (
                <th key={name} className="w-6 align-bottom font-normal">
                  <span className="block max-w-6 origin-bottom-left -rotate-45 whitespace-nowrap pb-1">{name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ICON_PACKS.map((pack) => (
              <tr key={pack.id} data-gallery-pack={pack.id}>
                <td className="whitespace-nowrap pr-3 text-label font-semibold text-ink">{pack.label}</td>
                {[...PREVIEW, ...LAYOUT].map((name) => (
                  <td key={name}>
                    <IconCell name={name} pack={pack.id} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Demo>
      <Demo label="State dot: the same 8px disc in every pack, at 12px (compact) and 16px, in the three state colors">
        {STATES.map(([label, color]) => (
          <span key={label} className={`flex items-center gap-1 ${color}`} title={label}>
            <Icon name="circleFilled" size={12} compact />
            <Icon name="circleFilled" size={16} />
            <span className="text-label text-ink-secondary">{label}</span>
          </span>
        ))}
      </Demo>
      <Demo label="Every icon of the active pack at 16px" className="max-w-[880px] gap-1">
        {SEMANTIC_ICON_NAMES.map((name) => (
          <span key={name} data-gallery-icon={name} className="flex size-6 items-center justify-center text-ink-secondary" title={name}>
            <Icon name={name} size={16} />
          </span>
        ))}
      </Demo>
    </GallerySection>
  );
}
