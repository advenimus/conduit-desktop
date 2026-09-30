import { useState } from "react";
import SshKeyGeneratorDialog from "./SshKeyGeneratorDialog";
import { IconButton } from "../ui";

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
      <IconButton size="sm" icon="shieldLock" label="SSH Key Generator" onClick={() => setShowDialog(true)} />
      {showDialog && (
        <SshKeyGeneratorDialog
          onClose={() => setShowDialog(false)}
          onUseKey={(key, fullResult) => {
            onKeyGenerated(key);
            if (fullResult && onFullKeyGenerated) {
              onFullKeyGenerated(fullResult);
            }
            setShowDialog(false);
          }}
        />
      )}
    </>
  );
}
