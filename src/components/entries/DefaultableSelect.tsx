/**
 * A select that adds a "Default (current value)" first option.
 * When "Default" is selected, the value is set to undefined (inherit from global defaults).
 */
import type { ChangeEvent } from "react";
import { Select } from "../ui";

interface DefaultableSelectProps<T extends string | number> {
  value: T | undefined;
  defaultLabel: string;
  options: { value: T; label: string }[];
  onChange: (value: T | undefined) => void;
  className?: string;
  "aria-label"?: string;
}

const SENTINEL = "__default__";

export default function DefaultableSelect<T extends string | number>({
  value,
  defaultLabel,
  options,
  onChange,
  className,
  "aria-label": ariaLabel,
}: DefaultableSelectProps<T>) {
  const selectValue = value === undefined ? SENTINEL : String(value);

  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    if (e.target.value === SENTINEL) {
      onChange(undefined);
      return;
    }
    const matched = options.find((o) => String(o.value) === e.target.value);
    if (matched) onChange(matched.value);
  };

  return (
    <Select value={selectValue} onChange={handleChange} className={className} aria-label={ariaLabel}>
      <option value={SENTINEL}>Default ({defaultLabel})</option>
      {options.map((opt) => (
        <option key={String(opt.value)} value={String(opt.value)}>
          {opt.label}
        </option>
      ))}
    </Select>
  );
}
