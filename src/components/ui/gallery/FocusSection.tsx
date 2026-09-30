import { useLayoutEffect, useRef, type ReactElement, type ReactNode } from "react";
import {
  Button,
  Card,
  Checkbox,
  ChoiceCard,
  ChoiceGroup,
  IconButton,
  ListRow,
  Menu,
  MenuItem,
  NavList,
  PasswordInput,
  Radio,
  RadioGroup,
  SearchInput,
  SegmentedControl,
  Select,
  Slider,
  Switch,
  Tabs,
  Textarea,
  TextInput,
  TreeRow,
} from "..";
import { CircleFilledIcon, GlobeIcon, TerminalIcon } from "../../../lib/icons";
import { Demo, GallerySection } from "./Section";

const noop = () => {};
const FOCUS = { "data-gallery-focus": "" };

/** Marks the first descendant matching `selector` as focused, for primitives that render their own items. */
function ForceFocus({ selector, children }: { selector: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    ref.current?.querySelector(selector)?.setAttribute("data-gallery-focus", "");
  });
  return (
    <span ref={ref} className="contents">
      {children}
    </span>
  );
}

/**
 * Every focusable primitive at a size that fits a tab strip, each forced into its focus state. Text
 * buttons are the small size, whose ring sits 2px outside it (spec 2.7). Spec 2.7 exempts text Buttons
 * md and lg, Textarea, Tabs and ChoiceCard from the strips, since none of them ever sits in one; they
 * show in the Card.
 */
function compactControls(): ReadonlyArray<ReactElement> {
  return [
    <Button key="sm" size="sm" {...FOCUS}>Button sm</Button>,
    <Button key="primary" size="sm" variant="primary" {...FOCUS}>Primary sm</Button>,
    <Button key="ghost" size="sm" variant="ghost" {...FOCUS}>Ghost sm</Button>,
    <Button key="link" variant="link" {...FOCUS}>Link</Button>,
    <IconButton key="ib-sm" size="sm" icon="close" label="IconButton sm" {...FOCUS} />,
    <IconButton key="ib-md" icon="splitHorizontal" label="IconButton md" {...FOCUS} />,
    <Checkbox key="check" checked onChange={noop} {...FOCUS}>Check</Checkbox>,
    <RadioGroup key="radio" aria-label="Radio" value="a" onChange={noop}>
      <Radio value="a" {...FOCUS}>Radio</Radio>
    </RadioGroup>,
    <Switch key="switch" checked onChange={noop} label="Switch" {...FOCUS} />,
    <ForceFocus key="segments" selector="[role=radio]">
      <SegmentedControl aria-label="Segments" value="a" onChange={noop} options={[{ value: "a", label: "One" }, { value: "b", label: "Two" }]} />
    </ForceFocus>,
    <div key="text" className="w-36">
      <TextInput aria-label="Text" defaultValue="TextInput" {...FOCUS} />
    </div>,
    <div key="password" className="w-36">
      <PasswordInput aria-label="Password" value="secret" onChange={noop} {...FOCUS} />
    </div>,
    <div key="search" className="w-40">
      <SearchInput aria-label="Search" value="query" onChange={noop} {...FOCUS} />
    </div>,
    <div key="select" className="w-32">
      <Select aria-label="Select" defaultValue="a" {...FOCUS}>
        <option value="a">Select</option>
      </Select>
    </div>,
    <div key="slider" className="w-28">
      <Slider aria-label="Slider" defaultValue={40} {...FOCUS} />
    </div>,
    <div key="listrow" className="w-36">
      <ListRow onClick={noop} leading="globe" {...FOCUS}>ListRow</ListRow>
    </div>,
    <div key="treerow" className="w-36" role="tree" aria-label="Tree">
      <TreeRow depth={0} leading="folder" {...FOCUS}>TreeRow</TreeRow>
    </div>,
    <div key="menuitem" className="w-36">
      <Menu aria-label="Menu" autoFocus={false}>
        <MenuItem onSelect={noop} icon="pencil" {...FOCUS}>MenuItem</MenuItem>
      </Menu>
    </div>,
    <ForceFocus key="nav" selector="button">
      <NavList aria-label="Nav" value="n" onChange={noop} items={[{ id: "n", label: "NavList", icon: "settings" }]} className="w-32" />
    </ForceFocus>,
  ];
}

/** A pane tab as spec 3.4 draws it: icon, label, state dot and an always-visible close button. */
function PaneTab({ title, icon, active = false, focusTab = false }: { title: string; icon: ReactNode; active?: boolean; focusTab?: boolean }) {
  return (
    <div className="cv-tab" data-active={active ? "" : undefined} tabIndex={active ? 0 : -1} {...(focusTab ? FOCUS : {})}>
      <span className="cv-tab-fill" />
      {icon}
      <span className="cv-tab-label">{title}</span>
      <span title="Connected" className="flex text-(--c-state-connected)">
        <CircleFilledIcon size={12} />
      </span>
      <IconButton size="sm" tone="inherit" className="cv-tab-close" icon="close" label={`Close ${title}`} tabIndex={-1} {...(active ? FOCUS : {})} />
    </div>
  );
}

function TabStrip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cv-tabstrip" data-tabbar="">
      <div className="cv-tabstrip-slot w-11 justify-center">
        <IconButton icon="menu" label={`Open sidebar (${label})`} />
      </div>
      <div className="cv-tabs">{children}</div>
      <div className="cv-tabstrip-slot">
        <IconButton icon="plus" label={`New Local Shell (${label})`} className="mx-1" {...FOCUS} />
        <IconButton icon="robot" label={`Toggle AI Panel (${label})`} className="mr-1" pressed />
      </div>
    </div>
  );
}

const STRIPS = 3;

export function FocusSection() {
  const controls = compactControls();
  const perStrip = Math.ceil(controls.length / STRIPS);
  return (
    <GallerySection id="focus" title="Focus rings inside a Card and a pane tab strip (spec 2.7)">
      <Demo label="Inside a Card: every focusable primitive in its focus state" className="block">
        <Card className="flex flex-wrap items-center gap-3">
          {controls}
          <Button {...FOCUS}>Button md</Button>
          <Button variant="primary" {...FOCUS}>Primary md</Button>
          <Button variant="danger" size="lg" {...FOCUS}>Danger lg</Button>
          <div className="w-60">
            <Textarea aria-label="Textarea" defaultValue="Textarea" {...FOCUS} />
          </div>
          <ForceFocus selector="[role=tab]">
            <Tabs aria-label="Panel tabs" value="a" onChange={noop} items={[{ value: "a", label: "Panel tab" }, { value: "b", label: "Other" }]} />
          </ForceFocus>
          <ForceFocus selector="[role=tab]">
            <Tabs aria-label="Underline tabs" variant="underline" value="a" onChange={noop} items={[{ value: "a", label: "Underline tab" }, { value: "b", label: "Other" }]} />
          </ForceFocus>
          <ChoiceGroup aria-label="Choice" value="a" onChange={noop} columns={2} className="w-72">
            <ChoiceCard value="a" label="ChoiceCard" description="Focused" {...FOCUS} />
            <ChoiceCard value="b" label="Other card" />
          </ChoiceGroup>
        </Card>
      </Demo>
      <Demo label="Flush against a container edge (overflow hidden, no padding)" className="block">
        <div className="w-80 overflow-hidden rounded-lg border border-card-border bg-editor">
          <ListRow onClick={noop} leading="folder" {...FOCUS}>
            First row, focused
          </ListRow>
          <ListRow onClick={noop} leading="folder">
            Second row
          </ListRow>
        </div>
      </Demo>
      <Demo label="Inside 33px pane tab strips (overflow hidden)" className="block">
        <div className="flex max-w-[1180px] flex-col overflow-hidden rounded-lg border border-card-border bg-editor">
          <TabStrip label="Sessions">
            <PaneTab title="web-01" icon={<TerminalIcon size={16} className="text-entry-ssh" />} active />
            <PaneTab title="Focused tab" icon={<GlobeIcon size={16} className="text-entry-web" />} focusTab />
            <PaneTab title="docs.example.com" icon={<GlobeIcon size={16} className="text-entry-web" />} />
          </TabStrip>
          {Array.from({ length: STRIPS }, (_, strip) => (
            <TabStrip key={strip} label={`Controls ${strip + 1}`}>
              {controls.slice(strip * perStrip, (strip + 1) * perStrip).map((control) => (
                <div key={control.key} className="flex shrink-0 items-center self-stretch px-1.5">
                  {control}
                </div>
              ))}
            </TabStrip>
          ))}
          <div className="h-10 bg-editor" />
        </div>
      </Demo>
    </GallerySection>
  );
}
