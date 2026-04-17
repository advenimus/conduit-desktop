import { useState } from "react";
import { createPortal } from "react-dom";
import SshKeyGeneratorDialog from "./SshKeyGeneratorDialog";
import { ShieldLockIcon } from "../../lib/icons";

interface SshKeyGenerateButtonProps {
  onKeyGenerated: (privateKey: string) => void;
  onFullKeyGenerated?: (result: { privateKey: string; publicKey: string; fingerprint: string }) => void;
}

export default function SshKeyGenerateButton({
  onKeyGenerated,
  onFullKeyGenerated,
}: SshKeyGenerateButtonProps) {
  const [showDialog, setShowDialog] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setShowDialog(true)}
        className="p-1 text-ink-faint hover:text-conduit-400"
        title="SSH Key Generator"
      >
        <ShieldLockIcon size={16} />
      </button>
      {showDialog &&
        createPortal(
          <SshKeyGeneratorDialog
            onClose={() => setShowDialog(false)}
            onUseKey={(key, fullResult) => {
              onKeyGenerated(key);
              if (fullResult && onFullKeyGenerated) {
                onFullKeyGenerated(fullResult);
              }
              setShowDialog(false);
            }}
          />,
          document.body
        )}
    </>
  );
}
