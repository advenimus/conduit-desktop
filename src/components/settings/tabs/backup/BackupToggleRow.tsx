import { useId, type ReactNode } from "react";
import { Switch } from "../../../ui";

interface BackupToggleRowProps {
  icon: ReactNode;
  title: string;
  /** Shown after the title, outside its <label>: the harness matches the label's exact text (B39). */
  aside?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}

/**
 * The Backup tab's toggle rows keep the harness-bound markup of SettingsRow's toggle row (B22, B39):
 * a <label> with the exact title and the switch a direct child of the row. SettingsRow has no slot
 * beside the title for the Cloud Backup badge, so the row is built here.
 */
export function BackupToggleRow({ icon, title, aside, checked, disabled, onChange }: BackupToggleRowProps) {
  const id = useId();
  return (
    <div data-cv-toggle-row="" className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        {icon}
        <label htmlFor={id} className="text-body font-semibold text-ink">
          {title}
        </label>
        {aside}
      </div>
      <Switch data-cv-toggle="" id={id} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
