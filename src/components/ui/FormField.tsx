import type { ReactNode } from "react";
import { cx } from "./cx";

export interface FormFieldProps {
  label: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  className?: string;
}

/**
 * <label><span>{label}</span>{control}</label>: the harness fills the control inside the label whose
 * first span is the label text (ui-forms.mjs fillLabeledInPage), so the label span must stay first.
 */
export function FormField({ label, children, description, error, className }: FormFieldProps) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-label font-semibold text-ink-secondary">{label}</span>
      {children}
      {description && <span className="mt-1 block text-meta text-ink-muted">{description}</span>}
      {error && (
        <p data-cv-error="" className="mt-1 text-meta text-danger">
          {error}
        </p>
      )}
    </label>
  );
}
