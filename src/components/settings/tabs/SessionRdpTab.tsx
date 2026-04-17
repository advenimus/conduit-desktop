import { useRef } from "react";
import type { TabProps } from "../SettingsHelpers";
import type { Settings } from "../SettingsHelpers";
import type { RdpGlobalDefaults, RdpGlobalResolution } from "../../../types/entry";
import { GLOBAL_RESOLUTION_OPTIONS, COLOR_DEPTH_OPTIONS, QUALITY_OPTIONS, SOUND_OPTIONS } from "../../../lib/sessionOptions";
import { HARDCODED_RDP_DEFAULTS } from "../../../types/entry";

interface SessionRdpTabProps extends TabProps {
  onApplyDisplayScale?: (updatedSettings: Settings) => void;
}

export default function SessionRdpTab({ settings, setSettings, onApplyDisplayScale }: SessionRdpTabProps) {
  const defaults = settings.session_defaults_rdp ?? { ...HARDCODED_RDP_DEFAULTS };
  const scaleBeforeDrag = useRef(defaults.displayScale ?? 1.0);

  const update = (partial: Partial<RdpGlobalDefaults>) => {
    setSettings({
      ...settings,
      session_defaults_rdp: { ...defaults, ...partial },
    });
  };

  const scalePercent = Math.round((defaults.displayScale ?? 1.0) * 100);

  // Map slider position (0-100) to display scale percent (50-200) with 100% at center (position 50)
  // Left half: 0-50 maps to 50%-100% (1:1 per unit)
  // Right half: 50-100 maps to 100%-200% (2:1 per unit)
  const scaleToSlider = (pct: number): number => {
    if (pct <= 100) return (pct - 50);           // 50%→0, 100%→50
    return 50 + (pct - 100) / 2;                 // 100%→50, 200%→100
  };
  const sliderToScale = (pos: number): number => {
    if (pos <= 50) return pos + 50;               // 0→50%, 50→100%
    return 100 + (pos - 50) * 2;                  // 50→100%, 100→200%
  };

  const sliderPos = scaleToSlider(scalePercent);

  const handleScaleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = sliderToScale(parseInt(e.target.value));
    const pct = Math.round(raw / 5) * 5; // snap to 5% increments
    update({ displayScale: pct / 100 });
  };

  const handleScaleCommit = () => {
    const currentScale = defaults.displayScale ?? 1.0;
    // Only reconnect if the value actually changed
    if (currentScale !== scaleBeforeDrag.current && onApplyDisplayScale) {
      const updatedSettings = {
        ...settings,
        session_defaults_rdp: { ...defaults, displayScale: currentScale },
      };
      onApplyDisplayScale(updatedSettings);
    }
    scaleBeforeDrag.current = currentScale;
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-muted">
        Default settings for all RDP connections. Individual entries can override these.
      </p>

      {/* Resolution */}
      <div>
        <label className="block text-sm font-medium mb-1">Resolution</label>
        <select
          value={defaults.resolution}
          onChange={(e) => update({ resolution: e.target.value as RdpGlobalResolution })}
          className="w-full px-3 py-2 bg-well border border-stroke rounded"
        >
          {GLOBAL_RESOLUTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Display Scale */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-sm font-medium">Display Scale</label>
          <span className="text-xs text-ink-muted tabular-nums">{scalePercent}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={sliderPos}
          onChange={handleScaleChange}
          onPointerDown={() => { scaleBeforeDrag.current = defaults.displayScale ?? 1.0; }}
          onPointerUp={handleScaleCommit}
          className="w-full accent-conduit-500"
        />
        <div className="flex justify-between text-[10px] text-ink-faint mt-0.5">
          <span>50% (smaller)</span>
          <span>100%</span>
          <span>200% (larger)</span>
        </div>
        <p className="text-[10px] text-ink-muted mt-1">
          Adjusts the effective resolution. Higher values make objects appear larger. Active sessions will reconnect on change.
        </p>
      </div>

      {/* Color Depth */}
      <div>
        <label className="block text-sm font-medium mb-1">Color Depth</label>
        <select
          value={defaults.colorDepth}
          onChange={(e) => update({ colorDepth: parseInt(e.target.value) as 32 | 24 | 16 | 15 })}
          className="w-full px-3 py-2 bg-well border border-stroke rounded"
        >
          {COLOR_DEPTH_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Quality */}
      <div>
        <label className="block text-sm font-medium mb-1">Quality</label>
        <select
          value={defaults.quality}
          onChange={(e) => update({ quality: e.target.value as "best" | "good" | "low" })}
          className="w-full px-3 py-2 bg-well border border-stroke rounded"
        >
          {QUALITY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Sound */}
      <div>
        <label className="block text-sm font-medium mb-1">Sound</label>
        <select
          value={defaults.sound}
          onChange={(e) => update({ sound: e.target.value as "local" | "remote" | "none" })}
          className="w-full px-3 py-2 bg-well border border-stroke rounded"
        >
          {SOUND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Checkboxes */}
      <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={defaults.enableHighDpi}
          onChange={(e) => update({ enableHighDpi: e.target.checked })}
          className="rounded border-stroke-dim bg-well text-conduit-500 focus:ring-conduit-500"
        />
        High DPI (Retina)
      </label>

      <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={defaults.clipboard}
          onChange={(e) => update({ clipboard: e.target.checked })}
          className="rounded border-stroke-dim bg-well text-conduit-500 focus:ring-conduit-500"
        />
        Clipboard Sharing
      </label>

      <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={defaults.enableNla}
          onChange={(e) => update({ enableNla: e.target.checked })}
          className="rounded border-stroke-dim bg-well text-conduit-500 focus:ring-conduit-500"
        />
        NLA (Network Level Auth)
      </label>
    </div>
  );
}
