import { CheckIcon, CloseIcon, FloppyIcon, PlayerSkipForwardIcon } from "../../../lib/icons";
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
      <div className="flex-none h-8 bg-panel border-b border-stroke flex items-center px-3 gap-2">
        <span className="text-xs text-ink-faint truncate flex-1">
          {pickedSelectors.usernameSelector && (
            <span className="inline-flex items-center gap-1 mr-2">
              <span className="text-blue-400">User:</span>
              <code className="text-[10px] bg-raised px-1 rounded max-w-[120px] truncate inline-block align-middle">
                {pickedSelectors.usernameSelector}
              </code>
            </span>
          )}
          {pickedSelectors.passwordSelector && (
            <span className="inline-flex items-center gap-1 mr-2">
              <span className="text-blue-400">Pass:</span>
              <code className="text-[10px] bg-raised px-1 rounded max-w-[120px] truncate inline-block align-middle">
                {pickedSelectors.passwordSelector}
              </code>
            </span>
          )}
          {pickedSelectors.submitSelector && (
            <span className="inline-flex items-center gap-1">
              <span className="text-blue-400">Submit:</span>
              <code className="text-[10px] bg-raised px-1 rounded max-w-[120px] truncate inline-block align-middle">
                {pickedSelectors.submitSelector}
              </code>
            </span>
          )}
          {!hasAny && <span className="text-ink-faint">No selectors picked — skip all to cancel</span>}
        </span>
        <button
          onClick={onSave}
          disabled={!hasAny || pickerSaving}
          className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-green-600 hover:bg-green-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Save selectors to entry"
        >
          <FloppyIcon size={14} />
          {pickerSaving ? "Saving..." : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-raised hover:bg-stroke text-ink-muted transition-colors"
          title="Cancel"
        >
          <CloseIcon size={14} />
        </button>
      </div>
    );
  }

  // Picking step
  const stepNum = pickerStep === "username" ? 1 : pickerStep === "password" ? 2 : 3;
  const hasPicked = pickedSelectors.usernameSelector || pickedSelectors.passwordSelector;

  return (
    <div className="flex-none h-8 bg-blue-950/50 border-b border-blue-500/30 flex items-center px-3 gap-2">
      <span className="text-xs text-blue-300 font-medium">
        {stepNum}/3
      </span>
      <span className="text-xs text-blue-200 truncate flex-1">
        {PICKER_STEP_LABELS[pickerStep as Exclude<PickerStep, "review">]}
      </span>
      {hasPicked && (
        <button
          onClick={onFinish}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-green-300 hover:bg-green-800/40 transition-colors"
          title="Skip remaining steps and review"
        >
          <CheckIcon size={14} />
          Done
        </button>
      )}
      <button
        onClick={onSkip}
        className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-blue-300 hover:bg-blue-800/50 transition-colors"
        title="Skip this step"
      >
        <PlayerSkipForwardIcon size={14} />
        Skip
      </button>
      <button
        onClick={onCancel}
        className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-raised hover:bg-stroke text-ink-muted transition-colors"
        title="Cancel picker"
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
