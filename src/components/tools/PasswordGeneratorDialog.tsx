import { useState, useEffect, useCallback } from "react";
import { toast } from "../common/Toast";
import {
  generatePassword,
  scorePassword,
  defaultSettings,
  type GeneratorMode,
  type GeneratorSettings,
  type StrengthResult,
} from "../../utils/passwordGenerator";
import { Button, Checkbox, Dialog, FormField, IconButton, SegmentedControl, Slider, TextInput, cx } from "../ui";
import { FULL_WIDTH_SEGMENTS } from "./segments";
import { strengthTone } from "./strengthTone";

interface PasswordGeneratorDialogProps {
  onClose: () => void;
  onUsePassword?: (password: string) => void;
}

const modes: { value: GeneratorMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "passphrase", label: "Passphrase" },
  { value: "pronounceable", label: "Pronounceable" },
];

function RangeField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-label font-semibold text-ink-secondary">{label}</label>
        <span className="text-body tabular-nums text-ink-muted">{value}</span>
      </div>
      <Slider min={min} max={max} value={value} onChange={(e) => onChange(parseInt(e.target.value))} />
    </div>
  );
}

export default function PasswordGeneratorDialog({
  onClose,
  onUsePassword,
}: PasswordGeneratorDialogProps) {
  const [settings, setSettings] = useState<GeneratorSettings>({
    ...defaultSettings,
    default: { ...defaultSettings.default },
    passphrase: { ...defaultSettings.passphrase },
    pronounceable: { ...defaultSettings.pronounceable },
  });
  const [password, setPassword] = useState("");
  const [strength, setStrength] = useState<StrengthResult>({
    score: 0,
    label: "Very Weak",
    color: "red-500",
    percent: 10,
  });
  const [showPassword, setShowPassword] = useState(true);

  const regenerate = useCallback(() => {
    const pw = generatePassword(settings);
    setPassword(pw);
    setStrength(scorePassword(pw));
  }, [settings]);

  // Auto-generate on settings change
  useEffect(() => {
    regenerate();
  }, [regenerate]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(password);
    toast.success("Password copied to clipboard");
  };

  const handleUse = () => {
    if (onUsePassword) {
      onUsePassword(password);
      onClose();
    }
  };

  const handleCopyAndClose = async () => {
    await navigator.clipboard.writeText(password);
    toast.success("Password copied to clipboard");
    onClose();
  };

  const updateDefault = (patch: Partial<GeneratorSettings["default"]>) => {
    setSettings((s) => ({
      ...s,
      default: { ...s.default, ...patch },
    }));
  };

  const updatePassphrase = (patch: Partial<GeneratorSettings["passphrase"]>) => {
    setSettings((s) => ({
      ...s,
      passphrase: { ...s.passphrase, ...patch },
    }));
  };

  const tone = strengthTone(strength.color);

  return (
    <Dialog
      open
      title="Password Generator"
      onClose={onClose}
      width={512}
      footer={
        <>
          {onUsePassword && (
            <Button variant="primary" onClick={handleUse}>
              Use Password
            </Button>
          )}
          <Button variant="secondary" onClick={handleCopyAndClose}>
            Copy & Close
          </Button>
        </>
      }
    >
      <SegmentedControl
        options={modes}
        value={settings.mode}
        onChange={(mode) => setSettings((s) => ({ ...s, mode }))}
        className={FULL_WIDTH_SEGMENTS}
      />

      <FormField label="Generated Password">
        <span className="relative block">
          <TextInput type={showPassword ? "text" : "password"} value={password} readOnly className="pr-20 font-mono" />
          <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            <IconButton size="sm" icon={showPassword ? "eyeOff" : "eye"} label={showPassword ? "Hide" : "Show"} onClick={() => setShowPassword(!showPassword)} />
            <IconButton size="sm" icon="refresh" label="Regenerate" onClick={regenerate} />
            <IconButton size="sm" icon="copy" label="Copy" onClick={handleCopy} />
          </span>
        </span>
      </FormField>

      <div>
        <div className="mb-1 flex items-center justify-between text-label">
          <span className="text-ink-muted">Strength</span>
          <span className={cx("font-medium", tone.text)}>{strength.label}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-well">
          <div className={cx("h-full rounded-full transition-all duration-300", tone.bar)} style={{ width: `${strength.percent}%` }} />
        </div>
      </div>

      {settings.mode === "default" && (
        <div className="space-y-3">
          <RangeField label="Length" value={settings.default.length} min={4} max={64} onChange={(length) => updateDefault({ length })} />

          <div className="grid grid-cols-2 gap-2">
            <Checkbox checked={settings.default.uppercase} onChange={(uppercase) => updateDefault({ uppercase })}>
              Uppercase (A-Z)
            </Checkbox>
            <Checkbox checked={settings.default.lowercase} onChange={(lowercase) => updateDefault({ lowercase })}>
              Lowercase (a-z)
            </Checkbox>
            <Checkbox checked={settings.default.numbers} onChange={(numbers) => updateDefault({ numbers })}>
              Numbers (0-9)
            </Checkbox>
            <Checkbox checked={settings.default.special} onChange={(special) => updateDefault({ special })}>
              Special (!@#$...)
            </Checkbox>
          </div>

          <div className="flex flex-col gap-2 border-t border-divider pt-2">
            <Checkbox checked={settings.default.excludeSimilar} onChange={(excludeSimilar) => updateDefault({ excludeSimilar })}>
              Exclude similar (i, l, 1, o, 0, O)
            </Checkbox>
            <Checkbox checked={settings.default.excludeAmbiguous} onChange={(excludeAmbiguous) => updateDefault({ excludeAmbiguous })}>
              {"Exclude ambiguous ({, }, [, ], /, \\, ...)"}
            </Checkbox>
          </div>
        </div>
      )}

      {settings.mode === "passphrase" && (
        <div className="space-y-3">
          <RangeField label="Words" value={settings.passphrase.wordCount} min={3} max={8} onChange={(wordCount) => updatePassphrase({ wordCount })} />

          <FormField label="Separator">
            <span className="block w-20">
              <TextInput value={settings.passphrase.separator} onChange={(e) => updatePassphrase({ separator: e.target.value })} maxLength={3} className="text-center" />
            </span>
          </FormField>

          <div className="flex flex-col gap-2">
            <Checkbox checked={settings.passphrase.capitalize} onChange={(capitalize) => updatePassphrase({ capitalize })}>
              Capitalize words
            </Checkbox>
            <Checkbox checked={settings.passphrase.includeNumber} onChange={(includeNumber) => updatePassphrase({ includeNumber })}>
              Include number
            </Checkbox>
          </div>
        </div>
      )}

      {settings.mode === "pronounceable" && (
        <RangeField
          label="Length"
          value={settings.pronounceable.length}
          min={6}
          max={32}
          onChange={(length) => setSettings((s) => ({ ...s, pronounceable: { length } }))}
        />
      )}
    </Dialog>
  );
}
