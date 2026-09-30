import { useState } from "react";
import { EyeIcon, EyeOffIcon } from "../../lib/icons";

interface PasswordInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
}

/** Labeled password field with a show/hide toggle, styled like the unlock dialog. */
export function PasswordInput({ label, value, onChange, autoFocus, placeholder }: PasswordInputProps) {
  const [show, setShow] = useState(false);
  return (
    <label className="block">
      <span className="block text-sm font-medium text-ink mb-1">{label}</span>
      <span className="relative block">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          placeholder={placeholder}
          className="w-full px-3 py-2 pr-10 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-ink-muted hover:text-ink"
          aria-label={show ? "Hide password" : "Show password"}
        >
          {show ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
        </button>
      </span>
    </label>
  );
}

export function InlineError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="p-3 bg-red-500/10 border border-red-500/20 rounded">
      <p className="text-sm text-red-400">{message}</p>
    </div>
  );
}
