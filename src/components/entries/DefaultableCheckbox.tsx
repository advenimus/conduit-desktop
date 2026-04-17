/**
 * A tri-state checkbox rendered as a select with Default / On / Off options.
 * When "Default" is selected, the value is undefined (inherit from global defaults).
 */

interface DefaultableCheckboxProps {
  value: boolean | undefined;
  defaultValue: boolean;
  label: string;
  onChange: (value: boolean | undefined) => void;
}

export default function DefaultableCheckbox({
  value,
  defaultValue,
  label,
  onChange,
}: DefaultableCheckboxProps) {
  const selectValue = value === undefined ? "default" : value ? "on" : "off";
  const defaultLabel = defaultValue ? "On" : "Off";

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-ink-secondary">{label}</span>
      <select
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "default" ? undefined : v === "on");
        }}
        className="px-2 py-1.5 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
      >
        <option value="default">Default ({defaultLabel})</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </div>
  );
}
