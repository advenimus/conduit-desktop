import { useEffect } from "react";
import { getPackMapping, loadPack } from "./pack-cache";
import { useIconPackStore } from "./store";
import { DEFAULT_ICON_SIZE, type IconPackId, type IconProps, type SemanticIconName } from "./types";

export interface IconElementProps extends IconProps {
  name: SemanticIconName;
  /** Render from this pack instead of the active one (previews). Falls back to the active pack until it loads. */
  pack?: IconPackId;
}

export function Icon({ name, pack, size = DEFAULT_ICON_SIZE, ...rest }: IconElementProps) {
  const activeMapping = useIconPackStore((state) => state.mapping);
  const packLoaded = useIconPackStore((state) => pack !== undefined && state.loaded.includes(pack));

  useEffect(() => {
    if (pack === undefined || packLoaded) return;
    loadPack(pack).catch((error: unknown) => {
      console.error(`[icons] Could not load the ${pack} icon pack for a preview`, error);
    });
  }, [pack, packLoaded]);

  const mapping = (pack !== undefined && packLoaded ? getPackMapping(pack) : null) ?? activeMapping;
  const PackIcon = mapping[name];
  return <PackIcon {...rest} size={size} />;
}
