import type { RdpEntryConfig, RdpResolution, RdpGlobalDefaults } from "../../../types/entry";
import { RESOLUTION_OPTIONS, COLOR_DEPTH_OPTIONS, QUALITY_OPTIONS } from "../../../lib/sessionOptions";
import DefaultableSelect from "../DefaultableSelect";
import DefaultableCheckbox from "../DefaultableCheckbox";
import Field from "../Field";

interface DisplayTabProps {
  config: Partial<RdpEntryConfig>;
  onChange: (config: Partial<RdpEntryConfig>) => void;
  globalDefaults: RdpGlobalDefaults;
}

export default function DisplayTab({ config, onChange, globalDefaults }: DisplayTabProps) {
  const update = (partial: Partial<RdpEntryConfig>) => {
    onChange({ ...config, ...partial });
  };

  // Effective resolution for showing custom width/height fields
  const effectiveResolution = config.resolution ?? globalDefaults.resolution;

  return (
    <div className="space-y-3">
      {/* Resolution */}
      <Field label="Resolution">
        <DefaultableSelect<RdpResolution>
          value={config.resolution}
          defaultLabel={RESOLUTION_OPTIONS.find((o) => o.value === globalDefaults.resolution)?.label ?? "Match Window"}
          options={RESOLUTION_OPTIONS}
          onChange={(v) => update({ resolution: v })}
        />
      </Field>

      {config.resolution === "custom" && (
        <div className="flex gap-2">
          <Field label="Width" className="flex-1">
            <input
              type="number"
              value={config.customWidth ?? 1920}
              onChange={(e) => update({ customWidth: parseInt(e.target.value) || 1920 })}
              min={800}
              max={7680}
              className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
            />
          </Field>
          <Field label="Height" className="flex-1">
            <input
              type="number"
              value={config.customHeight ?? 1080}
              onChange={(e) => update({ customHeight: parseInt(e.target.value) || 1080 })}
              min={600}
              max={4320}
              className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
            />
          </Field>
        </div>
      )}

      {/* Show custom dimension fields if the effective resolution is custom (from default or explicit) */}
      {effectiveResolution === "custom" && config.resolution !== "custom" && (
        <p className="text-xs text-ink-faint">
          Custom dimensions are configured per-entry. Set Resolution to "Custom" to specify.
        </p>
      )}

      {/* Color Depth */}
      <Field label="Color Depth">
        <DefaultableSelect<number>
          value={config.colorDepth}
          defaultLabel={COLOR_DEPTH_OPTIONS.find((o) => o.value === globalDefaults.colorDepth)?.label ?? "32-bit"}
          options={COLOR_DEPTH_OPTIONS}
          onChange={(v) => update({ colorDepth: v as 32 | 24 | 16 | 15 })}
        />
      </Field>

      {/* Quality */}
      <Field label="Quality">
        <DefaultableSelect<string>
          value={config.quality}
          defaultLabel={QUALITY_OPTIONS.find((o) => o.value === globalDefaults.quality)?.label ?? "Good"}
          options={QUALITY_OPTIONS}
          onChange={(v) => update({ quality: v as "best" | "good" | "low" })}
        />
      </Field>

      {/* High DPI */}
      <DefaultableCheckbox
        value={config.enableHighDpi}
        defaultValue={globalDefaults.enableHighDpi}
        label="High DPI (Retina)"
        onChange={(v) => update({ enableHighDpi: v })}
      />
    </div>
  );
}
