import type { EngineType } from "../../stores/aiStore";
import type { IconComponent, IconProps } from "../../lib/icons";
import { ENGINE_TYPES, getHarness } from "../../lib/ai-harnesses";
import { MenuItem } from "../ui";
import EngineLogo from "./EngineLogo";

// Stable per-engine components: MenuItem takes an icon component, and a new one per render would remount the logo.
const ENGINE_ICONS: Readonly<Record<EngineType, IconComponent>> = Object.freeze(
  Object.fromEntries(
    ENGINE_TYPES.map((type) => [type, ({ size, className }: IconProps) => <EngineLogo type={type} size={size} className={className} />]),
  ) as Record<EngineType, IconComponent>,
);

/** Every engine in order, the current one marked with a dot. In-memory only: callers never write settings. */
export default function EngineMenuItems({ current, onSelect }: { current: EngineType; onSelect: (type: EngineType) => void }) {
  return (
    <>
      {ENGINE_TYPES.map((type) => (
        <MenuItem
          key={type}
          onSelect={() => onSelect(type)}
          icon={ENGINE_ICONS[type]}
          end={current === type ? <span className="shrink-0 text-meta text-link">●</span> : undefined}
        >
          {getHarness(type).name}
        </MenuItem>
      ))}
    </>
  );
}
