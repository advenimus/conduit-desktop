import { cloneElement, isValidElement, useId, type ComponentPropsWithRef, type ReactElement, type ReactNode } from "react";

export interface FormFieldProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
  label: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
}

interface DescribableProps {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
}

function describe(control: ReactNode, ids: readonly string[], invalid: boolean): ReactNode {
  if (!isValidElement<DescribableProps>(control) || (ids.length === 0 && !invalid)) return control;
  const own = control.props["aria-describedby"];
  const describedBy = [own, ...ids].filter(Boolean).join(" ");
  const extra: DescribableProps = {};
  if (describedBy) extra["aria-describedby"] = describedBy;
  if (invalid && control.props["aria-invalid"] === undefined) extra["aria-invalid"] = true;
  return cloneElement(control as ReactElement<DescribableProps>, extra);
}

/**
 * <label><span>{label}</span>{control}</label>: the harness fills the control inside the label whose
 * first span is the label text (ui-forms.mjs fillLabeledInPage), so the label span must stay first. The
 * description and the error sit after the label, so they describe the control (aria-describedby) instead
 * of joining its name, and the error <p> is not invalid content inside a <label>.
 */
export function FormField({ label, children, description, error, className, ...rest }: FormFieldProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : null;
  const errorId = error ? `${id}-error` : null;
  const ids = [descriptionId, errorId].filter((value): value is string => value !== null);
  return (
    <div className={className} {...rest}>
      <label className="block">
        <span className="mb-1 block text-label font-semibold text-ink-secondary">{label}</span>
        {describe(children, ids, Boolean(error))}
      </label>
      {description && (
        <span id={descriptionId ?? undefined} className="mt-1 block text-meta text-ink-muted">
          {description}
        </span>
      )}
      {error && (
        <p id={errorId ?? undefined} data-cv-error="" className="mt-1 text-meta text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
