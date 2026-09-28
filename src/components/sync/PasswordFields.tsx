import { Callout, FormField, PasswordInput } from "../ui";

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
}

/** Labeled password field with a show/hide toggle; the harness fills it by its label (typeIntoLabeled). */
export function PasswordField({ label, value, onChange, autoFocus, placeholder }: PasswordFieldProps) {
  return (
    <FormField label={label}>
      <PasswordInput value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} placeholder={placeholder} />
    </FormField>
  );
}

/** A danger callout whose text is <p data-cv-error> (B8). */
export function InlineError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Callout tone="danger" size="sm">
      {message}
    </Callout>
  );
}
