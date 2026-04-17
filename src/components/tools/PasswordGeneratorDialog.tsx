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
import {
  CloseIcon, CopyIcon, EyeIcon, EyeOffIcon, RefreshIcon
} from "../../lib/icons";

interface PasswordGeneratorDialogProps {
  onClose: () => void;
  onUsePassword?: (password: string) => void;
}

const modes: { value: GeneratorMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "passphrase", label: "Passphrase" },
  { value: "pronounceable", label: "Pronounceable" },
];

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
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

  const strengthColors = {
    "red-500": { bar: "bg-red-500", text: "text-red-500" },
    "orange-500": { bar: "bg-orange-500", text: "text-orange-500" },
    "yellow-500": { bar: "bg-yellow-500", text: "text-yellow-500" },
    "green-500": { bar: "bg-green-500", text: "text-green-500" },
    "emerald-500": { bar: "bg-emerald-500", text: "text-emerald-500" },
  }[strength.color];

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
      onKeyDown={handleKeyDown}
    >
      <div data-dialog-content className="w-full max-w-lg bg-panel rounded-lg shadow-xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stroke sticky top-0 bg-panel rounded-t-lg">
          <h2 className="text-lg font-semibold text-ink">Password Generator</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-raised rounded"
          >
            <CloseIcon size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Mode selector */}
          <div className="flex gap-1 p-1 bg-well rounded-lg">
            {modes.map((m) => (
              <button
                key={m.value}
                onClick={() => setSettings((s) => ({ ...s, mode: m.value }))}
                className={`flex-1 py-1.5 px-3 text-sm rounded-md transition-colors ${
                  settings.mode === m.value
                    ? "bg-conduit-600 text-white"
                    : "hover:bg-raised text-ink-muted"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Generated password display */}
          <div>
            <label className="block text-sm font-medium mb-1 text-ink-muted">
              Generated Password
            </label>
            <div className="relative flex items-center gap-1">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                readOnly
                className="w-full px-3 py-2 pr-24 bg-well border border-stroke rounded font-mono text-sm text-ink focus:outline-none focus:ring-2 focus:ring-conduit-500"
              />
              <div className="absolute right-2 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="p-1 text-ink-faint hover:text-conduit-400"
                  title={showPassword ? "Hide" : "Show"}
                >
                  {showPassword ? (
                    <EyeOffIcon size={16} />
                  ) : (
                    <EyeIcon size={16} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={regenerate}
                  className="p-1 text-ink-faint hover:text-conduit-400"
                  title="Regenerate"
                >
                  <RefreshIcon size={16} />
                </button>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="p-1 text-ink-faint hover:text-conduit-400"
                  title="Copy"
                >
                  <CopyIcon size={16} />
                </button>
              </div>
            </div>
          </div>

          {/* Strength bar */}
          <div>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-ink-muted">Strength</span>
              <span className={`font-medium ${strengthColors?.text}`}>
                {strength.label}
              </span>
            </div>
            <div className="h-1.5 bg-well rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${strengthColors?.bar}`}
                style={{ width: `${strength.percent}%` }}
              />
            </div>
          </div>

          {/* Mode-specific settings */}
          {settings.mode === "default" && (
            <div className="space-y-3">
              {/* Length slider */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-ink-secondary">Length</label>
                  <span className="text-sm text-ink-muted tabular-nums">
                    {settings.default.length}
                  </span>
                </div>
                <input
                  type="range"
                  min={4}
                  max={64}
                  value={settings.default.length}
                  onChange={(e) =>
                    updateDefault({ length: parseInt(e.target.value) })
                  }
                  className="w-full accent-conduit-500"
                />
              </div>

              {/* Character set toggles */}
              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.default.uppercase}
                    onChange={(e) =>
                      updateDefault({ uppercase: e.target.checked })
                    }
                    className="accent-conduit-500"
                  />
                  Uppercase (A-Z)
                </label>
                <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.default.lowercase}
                    onChange={(e) =>
                      updateDefault({ lowercase: e.target.checked })
                    }
                    className="accent-conduit-500"
                  />
                  Lowercase (a-z)
                </label>
                <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.default.numbers}
                    onChange={(e) =>
                      updateDefault({ numbers: e.target.checked })
                    }
                    className="accent-conduit-500"
                  />
                  Numbers (0-9)
                </label>
                <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.default.special}
                    onChange={(e) =>
                      updateDefault({ special: e.target.checked })
                    }
                    className="accent-conduit-500"
                  />
                  Special (!@#$...)
                </label>
              </div>

              {/* Exclusion toggles */}
              <div className="space-y-2 pt-1 border-t border-stroke">
                <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.default.excludeSimilar}
                    onChange={(e) =>
                      updateDefault({ excludeSimilar: e.target.checked })
                    }
                    className="accent-conduit-500"
                  />
                  Exclude similar (i, l, 1, o, 0, O)
                </label>
                <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.default.excludeAmbiguous}
                    onChange={(e) =>
                      updateDefault({ excludeAmbiguous: e.target.checked })
                    }
                    className="accent-conduit-500"
                  />
                  {"Exclude ambiguous ({, }, [, ], /, \\, ...)"}
                </label>
              </div>
            </div>
          )}

          {settings.mode === "passphrase" && (
            <div className="space-y-3">
              {/* Word count slider */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-ink-secondary">Words</label>
                  <span className="text-sm text-ink-muted tabular-nums">
                    {settings.passphrase.wordCount}
                  </span>
                </div>
                <input
                  type="range"
                  min={3}
                  max={8}
                  value={settings.passphrase.wordCount}
                  onChange={(e) =>
                    updatePassphrase({ wordCount: parseInt(e.target.value) })
                  }
                  className="w-full accent-conduit-500"
                />
              </div>

              {/* Separator */}
              <div>
                <label className="block text-sm font-medium text-ink-secondary mb-1">
                  Separator
                </label>
                <input
                  type="text"
                  value={settings.passphrase.separator}
                  onChange={(e) =>
                    updatePassphrase({ separator: e.target.value })
                  }
                  maxLength={3}
                  className="w-20 px-3 py-1.5 bg-well border border-stroke rounded text-sm text-ink text-center focus:outline-none focus:ring-2 focus:ring-conduit-500"
                />
              </div>

              {/* Options */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.passphrase.capitalize}
                    onChange={(e) =>
                      updatePassphrase({ capitalize: e.target.checked })
                    }
                    className="accent-conduit-500"
                  />
                  Capitalize words
                </label>
                <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.passphrase.includeNumber}
                    onChange={(e) =>
                      updatePassphrase({ includeNumber: e.target.checked })
                    }
                    className="accent-conduit-500"
                  />
                  Include number
                </label>
              </div>
            </div>
          )}

          {settings.mode === "pronounceable" && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-medium">Length</label>
                <span className="text-sm text-ink-muted tabular-nums">
                  {settings.pronounceable.length}
                </span>
              </div>
              <input
                type="range"
                min={6}
                max={32}
                value={settings.pronounceable.length}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    pronounceable: { length: parseInt(e.target.value) },
                  }))
                }
                className="w-full accent-conduit-500"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-stroke">
          {onUsePassword && (
            <button
              onClick={handleUse}
              className="px-4 py-2 text-sm text-white bg-conduit-600 hover:bg-conduit-700 rounded"
            >
              Use Password
            </button>
          )}
          <button
            onClick={handleCopyAndClose}
            className="px-4 py-2 text-sm text-ink-secondary bg-raised hover:bg-raised/80 rounded"
          >
            Copy & Close
          </button>
        </div>
      </div>
    </div>
  );
}
