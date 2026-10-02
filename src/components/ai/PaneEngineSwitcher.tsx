import { useRef, useState } from "react";
import { ChevronDownIcon } from "../../lib/icons";
import { getHarness } from "../../lib/ai-harnesses";
import type { EngineType } from "../../stores/aiStore";
import { Menu, Popover, cx } from "../ui";
import EngineLogo from "./EngineLogo";
import EngineMenuItems from "./EngineMenuItems";

interface Props {
  engineType: EngineType;
  focused: boolean;
  onSelect: (type: EngineType) => void;
}

/** A pane header's engine name, as a menu that swaps only that pane's engine. */
export default function PaneEngineSwitcher({ engineType, focused, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const name = getHarness(engineType).name;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Switch this agent's engine (${name})`}
        className={cx(
          "flex h-5 min-w-0 items-center gap-1.5 rounded px-1 text-label hover:bg-hover hover:text-ink",
          focused ? "text-ink" : "text-ink-muted",
        )}
      >
        <EngineLogo type={engineType} size={12} />
        <span className="truncate">{name}</span>
        <ChevronDownIcon size={12} className="shrink-0 text-ink-muted" />
      </button>
      <Popover anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} padding={false} className="max-h-72 min-w-[200px] overflow-y-auto">
        <Menu onClose={() => setOpen(false)}>
          <EngineMenuItems current={engineType} onSelect={onSelect} />
        </Menu>
      </Popover>
    </>
  );
}
