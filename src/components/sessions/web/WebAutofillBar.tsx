import { CheckIcon, CloseIcon, FloppyIcon, PlayerSkipForwardIcon } from "../../../lib/icons";
import { Button, IconButton, cx } from "../../ui";
export type PickerStep = "username" | "password" | "submit" | "review";

export interface PickedSelectors {
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}

const PICKER_STEP_LABELS: Record<Exclude<PickerStep, "review">, string> = {
  username: "Click the username / email field",
  password: "Click the password field",
  submit: "Click the submit / login button",
};

interface WebAutofillBarProps {
  pickerStep: PickerStep;
  pickedSelectors: PickedSelectors;
  pickerSaving: boolean;
  onSkip: () => void;
  onFinish: () => void;
  onSave: () => void;
  onCancel: () => void;
}

const SELECTOR_LABELS: ReadonlyArray<{ key: keyof PickedSelectors; label: string }> = [
  { key: "usernameSelector", label: "User:" },
  { key: "passwordSelector", label: "Pass:" },
  { key: "submitSelector", label: "Submit:" },
];

export default function WebAutofillBar({
  pickerStep,
  pickedSelectors,
  pickerSaving,
  onSkip,
  onFinish,
  onSave,
  onCancel,
}: WebAutofillBarProps) {
  // Review step
  if (pickerStep === "review") {
    const hasAny = pickedSelectors.usernameSelector || pickedSelectors.passwordSelector || pickedSelectors.submitSelector;
    return (
      <div className="flex-none h-8 bg-editor border-b border-divider flex items-center px-3 gap-2">
        <span className="text-label text-ink-faint truncate flex-1">
          {SELECTOR_LABELS.map(({ key, label }, i) =>
            pickedSelectors[key] ? (
              <span key={key} className={cx("inline-flex items-center gap-1", i < SELECTOR_LABELS.length - 1 && "mr-2")}>
                <span className="text-info">{label}</span>
                <code className="text-badge bg-code px-1 rounded max-w-[120px] truncate inline-block align-middle">
                  {pickedSelectors[key]}
                </code>
              </span>
            ) : null,
          )}
          {!hasAny && <span className="text-ink-faint">No selectors picked — skip all to cancel</span>}
        </span>
        <Button
          size="sm"
          variant="primary"
          icon={FloppyIcon}
          onClick={onSave}
          disabled={!hasAny || pickerSaving}
          title="Save selectors to entry"
        >
          {pickerSaving ? "Saving..." : "Save"}
        </Button>
        <IconButton size="sm" icon={CloseIcon} label="Cancel" onClick={onCancel} />
      </div>
    );
  }

  // Picking step
  const stepNum = pickerStep === "username" ? 1 : pickerStep === "password" ? 2 : 3;
  const hasPicked = pickedSelectors.usernameSelector || pickedSelectors.passwordSelector;

  return (
    <div className="flex-none h-8 bg-info-bg border-b border-info-border flex items-center px-3 gap-2">
      <span className="text-label font-semibold text-info">
        {stepNum}/3
      </span>
      <span className="text-label text-ink-secondary truncate flex-1">
        {PICKER_STEP_LABELS[pickerStep as Exclude<PickerStep, "review">]}
      </span>
      {hasPicked && (
        <Button size="sm" variant="secondary" icon={CheckIcon} onClick={onFinish} title="Skip remaining steps and review">
          Done
        </Button>
      )}
      <Button size="sm" variant="ghost" icon={PlayerSkipForwardIcon} onClick={onSkip} title="Skip this step">
        Skip
      </Button>
      <IconButton size="sm" icon={CloseIcon} label="Cancel picker" onClick={onCancel} />
    </div>
  );
}
