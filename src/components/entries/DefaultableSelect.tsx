/**
 * A select that adds a "Default (current value)" first option.
 * When "Default" is selected, the value is set to undefined (inherit from global defaults).
 */

interface DefaultableSelectProps<T extends string | number> {
  value: T | undefined;
  defaultLabel: string;
  options: { value: T; label: string }[];
  onChange: (value: T | undefined) => void;
  className?: string;
}

const SENTINEL = "__default__";

export default function DefaultableSelect<T extends string | number>({
  value,
  defaultLabel,
  options,
  onChange,
  className,
}: DefaultableSelectProps<T>) {
  const selectValue = value === undefined ? SENTINEL : String(value);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (e.target.value === SENTINEL) {
      onChange(undefined);
    } else {
      const raw = e.target.value;
      const matched = options.find((o) => String(o.value) === raw);
      if (matched) {
        onChange(matched.value);
      }
    }
  };

  return (
    <select
      value={selectValue}
      onChange={handleChange}
      className={className ?? "w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"}
    >
      <option value={SENTINEL}>Default ({defaultLabel})</option>
      {options.map((opt) => (
        <option key={String(opt.value)} value={String(opt.value)}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
