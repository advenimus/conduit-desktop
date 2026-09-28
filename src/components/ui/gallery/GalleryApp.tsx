import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { SegmentedControl, Select } from "..";
import { ICON_PACKS, isIconPackId } from "../../../lib/icons";
import { COLOR_SCHEMES, isSchemeId } from "../../../lib/schemes";
import { ButtonsSection } from "./ButtonsSection";
import { DisplaySection } from "./DisplaySection";
import { FieldsSection } from "./FieldsSection";
import { FocusSection } from "./FocusSection";
import { applyGalleryState, gallerySearch, readGalleryState, type GalleryState } from "./galleryState";
import { IconsSection } from "./IconsSection";
import { NavigationSection } from "./NavigationSection";
import { OverlaysSection } from "./OverlaysSection";
import { RowsSection } from "./RowsSection";
import { installStateMirror } from "./stateMirror";

function Toolbar({ state, onChange }: { state: GalleryState; onChange: (next: Partial<GalleryState>) => void }) {
  return (
    <header className="sticky top-0 z-(--c-z-sticky) flex flex-wrap items-center gap-4 border-b border-divider bg-shell px-4 py-2">
      <h1 className="text-heading font-semibold text-ink">UI primitives</h1>
      <div className="w-36">
        <Select aria-label="Color scheme" value={state.scheme} onChange={(e) => isSchemeId(e.target.value) && onChange({ scheme: e.target.value })}>
          {COLOR_SCHEMES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>
      <SegmentedControl
        aria-label="Mode"
        value={state.mode}
        onChange={(mode) => onChange({ mode })}
        options={[
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
        ]}
      />
      <div className="w-44">
        <Select aria-label="Icon pack" value={state.pack} onChange={(e) => isIconPackId(e.target.value) && onChange({ pack: e.target.value })}>
          {ICON_PACKS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
      </div>
    </header>
  );
}

export function GalleryApp() {
  const [state, setState] = useState<GalleryState>(() => readGalleryState(window.location.search));

  useLayoutEffect(() => {
    applyGalleryState(state).catch((error: unknown) => console.error("[gallery] Could not apply the icon pack", error));
    window.history.replaceState(null, "", gallerySearch(state));
  }, [state]);

  useEffect(() => {
    installStateMirror();
  }, []);

  const sections: ReadonlyArray<[string, ReactNode]> = [
    ["focus", <FocusSection key="focus" />],
    ["buttons", <ButtonsSection key="buttons" />],
    ["fields", <FieldsSection key="fields" />],
    ["navigation", <NavigationSection key="navigation" mode={state.mode} />],
    ["overlays", <OverlaysSection key="overlays" />],
    ["rows", <RowsSection key="rows" />],
    ["display", <DisplaySection key="display" />],
    ["icons", <IconsSection key="icons" />],
  ];

  return (
    <div className="min-h-screen bg-shell text-ink">
      <Toolbar state={state} onChange={(next) => setState((prev) => ({ ...prev, ...next }))} />
      <main className="flex flex-col gap-4 p-4">
        {sections.filter(([id]) => state.section === null || state.section === id).map(([, node]) => node)}
      </main>
    </div>
  );
}
