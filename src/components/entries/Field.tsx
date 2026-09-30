import { useId, type ReactNode } from "react";
import { FormField } from "../ui";

interface FieldProps {
  label: string;
  required?: boolean;
  className?: string;
  description?: ReactNode;
  /**
   * For composite content (a field with its own buttons, an editor, a picker button): the label sits
   * above the content instead of wrapping it, so a click on the label text never presses a button.
   */
  group?: boolean;
  /** Group mode: the id of the control the label names. */
  htmlFor?: string;
  children: ReactNode;
}

export const FIELD_LABEL_TEXT = "block text-label font-semibold text-ink-secondary";
const FIELD_LABEL_CLASS = `mb-1 ${FIELD_LABEL_TEXT}`;

function LabelText({ label, required }: Pick<FieldProps, "label" | "required">) {
  return (
    <>
      {label}
      {required && (
        <span aria-hidden="true" className="ml-1 text-danger">
          *
        </span>
      )}
    </>
  );
}

/** A labeled entry field: FormField for a single control, a labeled group otherwise. */
export default function Field({ label, required, className, description, group, htmlFor, children }: FieldProps) {
  const id = useId();
  if (!group) {
    return (
      <FormField label={<LabelText label={label} required={required} />} description={description} className={className}>
        {children}
      </FormField>
    );
  }
  return (
    <div role="group" aria-labelledby={id} className={className}>
      <label id={id} htmlFor={htmlFor} className={FIELD_LABEL_CLASS}>
        <LabelText label={label} required={required} />
      </label>
      {children}
      {description && <span className="mt-1 block text-meta text-ink-muted">{description}</span>}
    </div>
  );
}
