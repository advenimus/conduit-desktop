import { useState } from "react";
import { toast } from "../common/Toast";
import { CheckIcon, CopyIcon, KeyIcon } from "../../lib/icons";

interface RecoveryPassphraseDialogProps {
  passphrase: string;
  onConfirm: () => void;
}

/**
 * Modal shown after identity key generation.
 * Displays the 6-word recovery passphrase for the user to save.
 */
export default function RecoveryPassphraseDialog({
  passphrase,
  onConfirm,
}: RecoveryPassphraseDialogProps) {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const words = passphrase.split(" ");

  const handleCopy = async () => {
    await navigator.clipboard.writeText(passphrase);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success("Recovery passphrase copied");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-dialog-content className="bg-panel border border-stroke rounded-lg shadow-xl w-[440px] p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <KeyIcon size={20} className="text-amber-400" />
          </div>
          <h2 className="text-lg font-semibold text-ink">
            Save Your Recovery Passphrase
          </h2>
        </div>

        {/* Passphrase display */}
        <div className="p-4 rounded-lg bg-well border border-stroke mb-4">
          <div className="flex flex-wrap justify-center gap-2">
            {words.map((word, i) => (
              <span
                key={i}
                className="px-3 py-1.5 rounded-md bg-panel border border-stroke text-base font-mono text-ink"
              >
                {word}
              </span>
            ))}
          </div>
        </div>

        {/* Warning */}
        <p className="text-sm text-ink-secondary mb-4">
          Write this down and store it safely. You'll need it to access team
          vaults from new devices. This passphrase cannot be recovered if lost.
        </p>

        {/* Confirmation checkbox */}
        <label className="flex items-start gap-2 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-1 rounded border-stroke"
          />
          <span className="text-sm text-ink-secondary">
            I have saved my recovery passphrase in a secure location
          </span>
        </label>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={handleCopy}
            className="px-4 py-2 text-sm text-ink-secondary hover:text-ink rounded-md hover:bg-well transition-colors flex items-center gap-1.5"
          >
            {copied ? (
              <>
                <CheckIcon size={14} className="text-green-400" />
                Copied
              </>
            ) : (
              <>
                <CopyIcon size={14} />
                Copy to Clipboard
              </>
            )}
          </button>
          <button
            onClick={onConfirm}
            disabled={!confirmed}
            className="px-4 py-2 text-sm bg-conduit-600 text-white rounded-md hover:bg-conduit-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            I've Saved It
          </button>
        </div>
      </div>
    </div>
  );
}
