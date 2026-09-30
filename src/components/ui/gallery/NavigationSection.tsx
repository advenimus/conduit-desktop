import { useState } from "react";
import { ChoiceCard, ChoiceGroup, NavList, SegmentedControl, TabPanel, Tabs, type NavEntry } from "..";
import { COLOR_SCHEMES } from "../../../lib/schemes";
import type { ResolvedMode } from "../../../lib/appearance/dom";
import { Demo, GallerySection } from "./Section";

const NAV: ReadonlyArray<NavEntry> = [
  { kind: "label", id: "l1", label: "Workspace" },
  { id: "general", label: "General", icon: "keyboard" },
  { id: "appearance", label: "Appearance", icon: "palette" },
  {
    kind: "group",
    id: "sessions",
    label: "Sessions",
    icon: "terminal",
    defaultExpanded: true,
    children: [
      { id: "sessions/ssh", label: "SSH", icon: "key" },
      { id: "sessions/rdp", label: "RDP", icon: "desktop" },
    ],
  },
  { id: "backup", label: "Backup", icon: "floppy" },
];

function SchemePreview({ id, mode }: { id: string; mode: ResolvedMode }) {
  const scheme = COLOR_SCHEMES.find((s) => s.id === id);
  const colors = scheme?.preview[mode];
  if (!colors) return null;
  return (
    <div className="relative h-12 overflow-hidden rounded" style={{ background: colors.shell }}>
      <div className="absolute bottom-1.5 left-1.5 top-1.5 w-3 rounded-sm" style={{ background: colors.sidebar }} />
      <div className="absolute bottom-1.5 left-6 right-1.5 top-1.5 rounded-lg" style={{ background: colors.editor }} />
      <div className="absolute bottom-3 left-8 h-1 w-3 rounded-full" style={{ background: colors.accent }} />
    </div>
  );
}

export function NavigationSection({ mode }: { mode: ResolvedMode }) {
  const [tab, setTab] = useState("edit");
  const [underline, setUnderline] = useState("problems");
  const [brightness, setBrightness] = useState("dark");
  const [nav, setNav] = useState("appearance");
  const [scheme, setScheme] = useState("modern");
  return (
    <GallerySection id="navigation" title="Tabs, SegmentedControl, NavList, ChoiceGroup">
      <Demo label='Tabs variant="panel"'>
        <div className="w-96">
          <Tabs
            aria-label="Editor mode"
            idBase="gallery-md"
            value={tab}
            onChange={setTab}
            items={[
              { value: "edit", label: "Edit", icon: "pencil" },
              { value: "preview", label: "Preview", icon: "eye" },
              { value: "split", label: "Split", icon: "splitHorizontal" },
              { value: "off", label: "Disabled", disabled: true },
            ]}
          />
          <TabPanel idBase="gallery-md" value={tab} className="px-2 py-1 text-meta text-ink-muted">
            Panel: {tab}
          </TabPanel>
        </div>
      </Demo>
      <Demo label='Tabs variant="underline"'>
        <Tabs
          aria-label="Panels"
          variant="underline"
          value={underline}
          onChange={setUnderline}
          items={[
            { value: "problems", label: "Problems" },
            { value: "output", label: "Output" },
            { value: "terminal", label: "Terminal" },
          ]}
        />
      </Demo>
      <Demo label="SegmentedControl">
        <SegmentedControl
          aria-label="Mode"
          value={brightness}
          onChange={setBrightness}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "system", label: "System" },
          ]}
        />
      </Demo>
      <Demo label="NavList (the Settings nav keeps w-52)" className="items-start">
        <NavList aria-label="Settings" items={NAV} value={nav} onChange={setNav} className="w-52 rounded border border-card-border bg-sidebar p-1" />
      </Demo>
      <Demo label="ChoiceGroup and ChoiceCard" className="block">
        <ChoiceGroup aria-label="Color scheme" value={scheme} onChange={setScheme} columns={4} className="max-w-[720px]">
          {COLOR_SCHEMES.map((s) => (
            <ChoiceCard key={s.id} value={s.id} label={s.label}>
              <SchemePreview id={s.id} mode={mode} />
            </ChoiceCard>
          ))}
        </ChoiceGroup>
      </Demo>
    </GallerySection>
  );
}
