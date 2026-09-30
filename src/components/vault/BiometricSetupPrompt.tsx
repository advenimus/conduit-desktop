import type { KeyboardEvent } from "react";
import { FingerprintIcon } from "../../lib/icons";

interface BiometricSetupPromptProps {
  onKeyDown: (e: KeyboardEvent) => void;
  onDismiss: () => void;
  onAccept: () => void;
}

/** Offered after the first password unlock of a vault. */
export default function BiometricSetupPrompt({ onKeyDown, onDismiss, onAccept }: BiometricSetupPromptProps) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50" onKeyDown={onKeyDown}>
      <div data-dialog-content className="w-full max-w-sm bg-panel rounded-lg shadow-xl">
        <div className="flex flex-col items-center pt-6 pb-2 px-4">
          <div className="w-12 h-12 bg-conduit-600/20 rounded-full flex items-center justify-center mb-3">
            <FingerprintIcon size={24} className="text-conduit-400" />
          </div>
          <h2 className="text-lg font-semibold">Enable Quick Unlock</h2>
          <p className="text-sm text-ink-muted mt-2 text-center">
            Unlock this vault faster next time with Touch ID, Apple Watch, or your system password.
          </p>
        </div>

        <div className="flex justify-end gap-2 px-4 py-4 border-t border-stroke mt-2">
          <button type="button" onClick={onDismiss} className="px-4 py-2 text-sm hover:bg-raised rounded">
            Not Now
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="px-4 py-2 text-sm text-white bg-conduit-600 hover:bg-conduit-700 rounded"
          >
            Enable
          </button>
        </div>
      </div>
    </div>
  );
}
