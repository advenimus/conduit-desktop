import { useRef, useState } from "react";
import type { IconComponent } from "../../lib/icons";
import { PaletteIcon } from "../../lib/icons";
import { Button } from "../ui";
import ColorPicker from "./ColorPicker";
import IconPicker from "./IconPicker";
import type { EntryColorResult } from "./entryIcons";

interface AppearancePickersProps {
  Icon: IconComponent;
  colorResult: EntryColorResult;
  customIcon: string | null;
  setCustomIcon: (v: string | null) => void;
  customColor: string | null;
  setCustomColor: (v: string | null) => void;
  /** Button texts: [default, custom]. */
  iconLabels: readonly [string, string];
  colorLabels: readonly [string, string];
}

/** The Appearance row of the entry and folder forms: a preview tile, then the icon and color pickers. */
export default function AppearancePickers({
  Icon,
  colorResult,
  customIcon,
  setCustomIcon,
  customColor,
  setCustomColor,
  iconLabels,
  colorLabels,
}: AppearancePickersProps) {
  const [open, setOpen] = useState<"icon" | "color" | null>(null);
  const iconBtnRef = useRef<HTMLButtonElement>(null);
  const colorBtnRef = useRef<HTMLButtonElement>(null);
  const toggle = (picker: "icon" | "color") => setOpen((current) => (current === picker ? null : picker));
  const close = () => setOpen(null);

  return (
    <div className="flex items-center gap-3">
      <div className="flex size-9 items-center justify-center rounded-md border border-card-border bg-well">
        <Icon size={20} className={colorResult.className} style={colorResult.style} />
      </div>

      <Button ref={iconBtnRef} icon="icons" onClick={() => toggle("icon")}>
        {customIcon ? iconLabels[1] : iconLabels[0]}
      </Button>
      {open === "icon" && (
        <IconPicker value={customIcon} onSelect={setCustomIcon} onClose={close} customColor={customColor} anchorRef={iconBtnRef} />
      )}

      <Button ref={colorBtnRef} onClick={() => toggle("color")}>
        {customColor ? (
          <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: customColor }} />
        ) : (
          <PaletteIcon size={16} className="shrink-0" />
        )}
        {customColor ? colorLabels[1] : colorLabels[0]}
      </Button>
      {open === "color" && <ColorPicker value={customColor} onSelect={setCustomColor} onClose={close} anchorRef={colorBtnRef} />}
    </div>
  );
}
