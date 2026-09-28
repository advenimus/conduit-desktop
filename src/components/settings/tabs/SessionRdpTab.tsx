import { useRef } from "react";
import type { TabProps } from "../SettingsHelpers";
import type { Settings } from "../SettingsHelpers";
import type { RdpGlobalDefaults, RdpGlobalResolution } from "../../../types/entry";
import { GLOBAL_RESOLUTION_OPTIONS, COLOR_DEPTH_OPTIONS, QUALITY_OPTIONS, SOUND_OPTIONS } from "../../../lib/sessionOptions";
import { HARDCODED_RDP_DEFAULTS } from "../../../types/entry";
import { Checkbox, FormField, Select, Slider } from "../../ui";
import { CAPTION, HINT, SECTION_LABEL } from "../settings-styles";

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
      <p className={HINT}>
        Default settings for all RDP connections. Individual entries can override these.
      </p>

      <FormField label="Resolution">
        <Select value={defaults.resolution} onChange={(e) => update({ resolution: e.target.value as RdpGlobalResolution })}>
          {GLOBAL_RESOLUTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </Select>
      </FormField>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label htmlFor="rdp-display-scale" className={SECTION_LABEL}>Display Scale</label>
          <span className={CAPTION}>{scalePercent}%</span>
        </div>
        <Slider
          id="rdp-display-scale"
          min={0}
          max={100}
          step={1}
          value={sliderPos}
          onChange={handleScaleChange}
          onPointerDown={() => { scaleBeforeDrag.current = defaults.displayScale ?? 1.0; }}
          onPointerUp={handleScaleCommit}
          marks={["50% (smaller)", "100%", "200% (larger)"]}
        />
        <p className={`mt-1 ${HINT}`}>
          Adjusts the effective resolution. Higher values make objects appear larger. Active sessions will reconnect on change.
        </p>
      </div>

      <FormField label="Color Depth">
        <Select value={defaults.colorDepth} onChange={(e) => update({ colorDepth: parseInt(e.target.value) as 32 | 24 | 16 | 15 })}>
          {COLOR_DEPTH_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </Select>
      </FormField>

      <FormField label="Quality">
        <Select value={defaults.quality} onChange={(e) => update({ quality: e.target.value as "best" | "good" | "low" })}>
          {QUALITY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </Select>
      </FormField>

      <FormField label="Sound">
        <Select value={defaults.sound} onChange={(e) => update({ sound: e.target.value as "local" | "remote" | "none" })}>
          {SOUND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </Select>
      </FormField>

      <div className="flex flex-col gap-3">
        <Checkbox checked={defaults.enableHighDpi} onChange={(enableHighDpi) => update({ enableHighDpi })}>
          High DPI (Retina)
        </Checkbox>
        <Checkbox checked={defaults.clipboard} onChange={(clipboard) => update({ clipboard })}>
          Clipboard Sharing
        </Checkbox>
        <Checkbox checked={defaults.enableNla} onChange={(enableNla) => update({ enableNla })}>
          NLA (Network Level Auth)
        </Checkbox>
      </div>
    </div>
  );
}
