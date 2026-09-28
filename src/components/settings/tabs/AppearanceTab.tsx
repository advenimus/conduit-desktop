import { useEffect } from "react";
import { COLOR_SCHEMES, type SchemePreview } from "../../../lib/schemes";
import { DEFAULT_ICON_PACK, ICON_PACKS, Icon, isIconPackId, preloadAllIconPacks, type IconPackId, type SemanticIconName } from "../../../lib/icons";
import { Badge, ChoiceCard, ChoiceGroup } from "../../ui";
import type { TabProps } from "../SettingsHelpers";

const PACK_PREVIEW: ReadonlyArray<SemanticIconName> = ["folder", "terminal", "desktop", "globe", "key", "search", "settings", "cloud"];

export default function AppearanceTab({ settings, setSettings }: TabProps) {
  // Sync ui_scale with actual zoom factor (covers Cmd+/- and other external changes)
  useEffect(() => {
    // Read current zoom factor on mount
    window.electron?.invoke?.("get-zoom-factor").then((factor: unknown) => {
      if (typeof factor === "number" && factor >= 0.75 && factor <= 1.5) {
        const rounded = Math.round(factor * 20) / 20; // snap to 0.05 steps
        if (rounded !== (settings.ui_scale ?? 1)) {
          setSettings((prev) => ({ ...prev, ui_scale: rounded }));
        }
      }
    });

    // Listen for zoom changes from keyboard shortcuts
    const unsub = window.electron?.on?.("zoom-factor-changed", (factor: unknown) => {
      if (typeof factor === "number" && factor >= 0.75 && factor <= 1.5) {
        const rounded = Math.round(factor * 20) / 20;
        setSettings((prev) => ({ ...prev, ui_scale: rounded }));
      }
    });

    return () => { unsub?.(); };
  }, []);
  const isDark =
    settings.theme === "dark" ||
    (settings.theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  function dispatchThemeChange(detail: Record<string, string>) {
    document.dispatchEvent(
      new CustomEvent("conduit:theme-change", { detail })
    );
  }

  return (
    <div className="space-y-6">
      <IconPackSection
        value={isIconPackId(settings.icon_pack) ? settings.icon_pack : DEFAULT_ICON_PACK}
        onChange={(pack) => {
          setSettings((prev) => ({ ...prev, icon_pack: pack }));
          dispatchThemeChange({ iconPack: pack });
        }}
      />

      {/* ── Color Scheme ── */}
      <div>
        <label className="block text-sm font-medium mb-2">Color Scheme</label>

        <div className="grid grid-cols-3 gap-2">
          {COLOR_SCHEMES.map((scheme) => {
            const p = isDark ? scheme.preview.dark : scheme.preview.light;
            const isActive = settings.color_scheme === scheme.id;
            return (
              <SchemeCard
                key={scheme.id}
                label={scheme.label}
                preview={p}
                isDark={isDark}
                isActive={isActive}
                onClick={() => {
                  setSettings({ ...settings, color_scheme: scheme.id });
                  dispatchThemeChange({ colorScheme: scheme.id });
                }}
              />
            );
          })}
        </div>
      </div>

      {/* ── Display ── */}
      <div className="flex gap-4">
        {/* Brightness */}
        <div className="flex-1">
          <label className="block text-sm font-medium mb-1">Brightness</label>
          <div className="flex bg-well rounded-lg p-0.5">
            {(["dark", "light", "system"] as const).map((t) => {
              const isActive = settings.theme === t;
              return (
                <button
                  key={t}
                  onClick={() => {
                    setSettings({ ...settings, theme: t });
                    dispatchThemeChange({ theme: t });
                  }}
                  className={`flex-1 text-center py-1.5 text-xs rounded-md capitalize transition-all ${
                    isActive
                      ? "bg-raised text-ink font-medium shadow-sm"
                      : "text-ink-muted hover:text-ink-secondary"
                  }`}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </div>

        {/* UI Scale */}
        <div className="flex-1">
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium">UI Scale</label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-muted tabular-nums">
                {Math.round((settings.ui_scale ?? 1) * 100)}%
              </span>
              {(settings.ui_scale ?? 1) !== 1 && (
                <button
                  onClick={() => {
                    setSettings({ ...settings, ui_scale: 1 });
                    window.electron?.send?.("set-zoom-factor", 1);
                  }}
                  className="text-[10px] text-conduit-400 hover:text-conduit-300"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
          <UiScaleSlider
            value={settings.ui_scale ?? 1}
            onChange={(val) => setSettings({ ...settings, ui_scale: val })}
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
      <label id="appearance-icon-pack-label" className="block text-sm font-medium mb-2">Icon pack</label>
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

/**
 * UI Scale slider with 100% centered at the midpoint.
 * Left half: 0-50 maps to 75%-100% (0.5% per unit)
 * Right half: 50-100 maps to 100%-150% (1% per unit)
 * Output snaps to 5% increments.
 */
function UiScaleSlider({ value, onChange, onCommit }: {
  value: number;
  onChange: (val: number) => void;
  onCommit: (val: number) => void;
}) {
  const pct = Math.round(value * 100);

  const scaleToSlider = (p: number): number => {
    if (p <= 100) return (p - 75) * 2;           // 75%→0, 100%→50
    return 50 + (p - 100);                        // 100%→50, 150%→100
  };
  const sliderToScale = (pos: number): number => {
    if (pos <= 50) return 75 + pos / 2;            // 0→75%, 50→100%
    return 100 + (pos - 50);                       // 50→100%, 100→150%
  };

  const sliderPos = scaleToSlider(pct);

  return (
    <>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={sliderPos}
        onChange={(e) => {
          const raw = sliderToScale(parseInt(e.target.value));
          const snapped = Math.round(raw / 5) * 5;
          onChange(snapped / 100);
        }}
        onMouseUp={(e) => {
          const raw = sliderToScale(parseInt((e.target as HTMLInputElement).value));
          const snapped = Math.round(raw / 5) * 5;
          onCommit(snapped / 100);
        }}
        onTouchEnd={(e) => {
          const raw = sliderToScale(parseInt((e.target as HTMLInputElement).value));
          const snapped = Math.round(raw / 5) * 5;
          onCommit(snapped / 100);
        }}
        className="w-full accent-conduit-500"
      />
      <div className="flex justify-between text-[10px] text-ink-faint mt-0.5">
        <span>75%</span>
        <span>100%</span>
        <span>150%</span>
      </div>
    </>
  );
}

/** Reusable color scheme card component */
function SchemeCard({
  label,
  preview,
  isDark,
  isActive,
  onClick,
}: {
  label: string;
  preview: SchemePreview;
  isDark: boolean;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-all ${
        isActive
          ? "border-conduit-500 ring-2 ring-conduit-500/30 bg-well"
          : "border-stroke hover:border-ink-faint bg-transparent"
      }`}
    >
      <div
        className="w-full h-10 rounded-md overflow-hidden flex items-end"
        style={{ background: preview.shell }}
      >
        <div
          className="w-full h-6 rounded-t-sm flex items-center px-2 gap-1.5"
          style={{ background: preview.editor }}
        >
          <div className="w-5 h-2 rounded-sm" style={{ background: preview.accent }} />
          <div
            className="flex-1 h-1.5 rounded-sm opacity-30"
            style={{ background: isDark ? "#fff" : "#000" }}
          />
        </div>
      </div>
      <span className={`text-xs ${isActive ? "font-medium text-conduit-400" : "text-ink-muted"}`}>
        {label}
      </span>
    </button>
  );
}
