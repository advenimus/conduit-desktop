import { useEffect } from "react";
import { COLOR_SCHEMES, type SchemePreview } from "../../../lib/schemes";
import { DEFAULT_ICON_PACK, ICON_PACKS, Icon, isIconPackId, preloadAllIconPacks, type IconPackId, type SemanticIconName } from "../../../lib/icons";
import { Badge, Button, ChoiceCard, ChoiceGroup, SegmentedControl, Slider, type SegmentOption } from "../../ui";
import type { TabProps } from "../SettingsHelpers";
import { CAPTION, SECTION_LABEL } from "../settings-styles";

const PACK_PREVIEW: ReadonlyArray<SemanticIconName> = ["folder", "terminal", "desktop", "globe", "key", "search", "settings", "cloud"];

type Brightness = "dark" | "light" | "system";

const BRIGHTNESS_OPTIONS: ReadonlyArray<SegmentOption<Brightness>> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

function isBrightness(value: string): value is Brightness {
  return BRIGHTNESS_OPTIONS.some((o) => o.value === value);
}

function dispatchThemeChange(detail: Record<string, string>) {
  document.dispatchEvent(new CustomEvent("conduit:theme-change", { detail }));
}

function snapZoom(factor: unknown): number | null {
  if (typeof factor !== "number" || factor < 0.75 || factor > 1.5) return null;
  return Math.round(factor * 20) / 20;
}

export default function AppearanceTab({ settings, setSettings }: TabProps) {
  // Sync ui_scale with the actual zoom factor (covers Cmd+/- and other external changes)
  useEffect(() => {
    window.electron?.invoke?.("get-zoom-factor").then((factor: unknown) => {
      const rounded = snapZoom(factor);
      if (rounded !== null && rounded !== (settings.ui_scale ?? 1)) {
        setSettings((prev) => ({ ...prev, ui_scale: rounded }));
      }
    });
    const unsub = window.electron?.on?.("zoom-factor-changed", (factor: unknown) => {
      const rounded = snapZoom(factor);
      if (rounded !== null) setSettings((prev) => ({ ...prev, ui_scale: rounded }));
    });
    return () => { unsub?.(); };
  }, []);

  const isDark =
    settings.theme === "dark" ||
    (settings.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const scale = settings.ui_scale ?? 1;

  return (
    <div className="space-y-6">
      <IconPackSection
        value={isIconPackId(settings.icon_pack) ? settings.icon_pack : DEFAULT_ICON_PACK}
        onChange={(pack) => {
          setSettings((prev) => ({ ...prev, icon_pack: pack }));
          dispatchThemeChange({ iconPack: pack });
        }}
      />

      <div data-cv-appearance="scheme">
        <label id="appearance-scheme-label" className={`${SECTION_LABEL} mb-2`}>Color Scheme</label>
        <ChoiceGroup
          aria-labelledby="appearance-scheme-label"
          value={settings.color_scheme}
          onChange={(scheme) => {
            setSettings((prev) => ({ ...prev, color_scheme: scheme }));
            dispatchThemeChange({ colorScheme: scheme });
          }}
          columns={3}
        >
          {COLOR_SCHEMES.map((scheme) => (
            <ChoiceCard key={scheme.id} value={scheme.id} label={scheme.label} className="items-center">
              <SchemePreviewStrip preview={isDark ? scheme.preview.dark : scheme.preview.light} isDark={isDark} />
            </ChoiceCard>
          ))}
        </ChoiceGroup>
      </div>

      <div className="flex gap-4">
        <div data-cv-appearance="mode" className="flex-1">
          <label id="appearance-mode-label" className={`${SECTION_LABEL} mb-1`}>Brightness</label>
          <SegmentedControl
            aria-labelledby="appearance-mode-label"
            options={BRIGHTNESS_OPTIONS}
            value={isBrightness(settings.theme) ? settings.theme : "system"}
            onChange={(theme) => {
              setSettings((prev) => ({ ...prev, theme }));
              dispatchThemeChange({ theme });
            }}
            className="flex w-full [&>button]:flex-1 [&>button]:justify-center"
          />
        </div>

        <div data-cv-appearance="scale" className="flex-1">
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="appearance-ui-scale" className={SECTION_LABEL}>UI Scale</label>
            <div className="flex items-center gap-2">
              <span className={CAPTION}>{Math.round(scale * 100)}%</span>
              {scale !== 1 && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setSettings((prev) => ({ ...prev, ui_scale: 1 }));
                    window.electron?.send?.("set-zoom-factor", 1);
                  }}
                >
                  Reset
                </Button>
              )}
            </div>
          </div>
          <UiScaleSlider
            value={scale}
            onChange={(val) => setSettings((prev) => ({ ...prev, ui_scale: val }))}
            onCommit={(val) => window.electron?.send?.("set-zoom-factor", val)}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Settings > Appearance > Icon pack (spec 5.8): every card previews its own pack, so all packs load on mount.
 * Two columns: eight 16px icons with 8px gaps need 200px, and a third of today's 768px dialog leaves 148px.
 */
function IconPackSection({ value, onChange }: { value: IconPackId; onChange: (pack: IconPackId) => void }) {
  useEffect(() => {
    void preloadAllIconPacks();
  }, []);

  return (
    <div data-cv-appearance="icon-pack">
      <label id="appearance-icon-pack-label" className={`${SECTION_LABEL} mb-2`}>Icon pack</label>
      <ChoiceGroup aria-labelledby="appearance-icon-pack-label" value={value} onChange={onChange} columns={2}>
        {ICON_PACKS.map((pack) => (
          <ChoiceCard
            key={pack.id}
            value={pack.id}
            label={
              <span className="inline-flex items-center gap-1.5">
                {pack.label}
                {pack.id === DEFAULT_ICON_PACK && <Badge tone="neutral">Default</Badge>}
              </span>
            }
            description={pack.description}
          >
            <span className="flex h-8 items-center gap-2 rounded bg-well px-2 text-ink-secondary">
              {PACK_PREVIEW.map((name) => (
                <Icon key={name} name={name} pack={pack.id} size={16} className="shrink-0" />
              ))}
            </span>
          </ChoiceCard>
        ))}
      </ChoiceGroup>
    </div>
  );
}

const scaleToSlider = (p: number): number => (p <= 100 ? (p - 75) * 2 : 50 + (p - 100));
const sliderToScale = (pos: number): number => (pos <= 50 ? 75 + pos / 2 : 100 + (pos - 50));
const snappedScale = (pos: string): number => (Math.round(sliderToScale(parseInt(pos)) / 5) * 5) / 100;

/**
 * UI Scale slider with 100% centered at the midpoint: 0-50 maps to 75%-100%, 50-100 to 100%-150%.
 * Output snaps to 5% increments.
 */
function UiScaleSlider({ value, onChange, onCommit }: {
  value: number;
  onChange: (val: number) => void;
  onCommit: (val: number) => void;
}) {
  return (
    <Slider
      id="appearance-ui-scale"
      min={0}
      max={100}
      step={1}
      value={scaleToSlider(Math.round(value * 100))}
      onChange={(e) => onChange(snappedScale(e.target.value))}
      onMouseUp={(e) => onCommit(snappedScale(e.currentTarget.value))}
      onTouchEnd={(e) => onCommit(snappedScale(e.currentTarget.value))}
      marks={["75%", "100%", "150%"]}
    />
  );
}

/** A shell strip holding an editor block with the scheme's accent bar (6.4). */
function SchemePreviewStrip({ preview, isDark }: { preview: SchemePreview; isDark: boolean }) {
  return (
    <span className="flex h-10 w-full items-end overflow-hidden rounded" style={{ background: preview.shell }}>
      <span className="flex h-6 w-full items-center gap-1.5 rounded-t-sm px-2" style={{ background: preview.editor }}>
        <span className="h-2 w-5 rounded-sm" style={{ background: preview.accent }} />
        <span className="h-1.5 flex-1 rounded-sm opacity-30" style={{ background: isDark ? "#fff" : "#000" }} />
      </span>
    </span>
  );
}
