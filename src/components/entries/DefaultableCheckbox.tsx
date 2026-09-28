/**
 * A tri-state checkbox rendered as a select with Default / On / Off options.
 * When "Default" is selected, the value is undefined (inherit from global defaults).
 */
import { Select } from "../ui";

interface DefaultableCheckboxProps {
  value: boolean | undefined;
  defaultValue: boolean;
  label: string;
  onChange: (value: boolean | undefined) => void;
}

export default function DefaultableCheckbox({ value, defaultValue, label, onChange }: DefaultableCheckboxProps) {
  const selectValue = value === undefined ? "default" : value ? "on" : "off";
  const defaultLabel = defaultValue ? "On" : "Off";

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-body text-ink-secondary">{label}</span>
      <div className="shrink-0">
        <Select
          value={selectValue}
          aria-label={label}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === "default" ? undefined : v === "on");
          }}
        >
          <option value="default">Default ({defaultLabel})</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </Select>
      </div>
    </div>
  );
}
