import { useState } from "react";
import { createPortal } from "react-dom";
import PasswordGeneratorDialog from "./PasswordGeneratorDialog";
import { KeyIcon } from "../../lib/icons";

interface PasswordGenerateButtonProps {
  onPasswordGenerated: (password: string) => void;
}

export default function PasswordGenerateButton({
  onPasswordGenerated,
}: PasswordGenerateButtonProps) {
  const [showDialog, setShowDialog] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setShowDialog(true)}
        className="p-1 text-ink-faint hover:text-conduit-400"
        title="Password Generator"
      >
        <KeyIcon size={16} />
      </button>
      {showDialog &&
        createPortal(
          <PasswordGeneratorDialog
            onClose={() => setShowDialog(false)}
            onUsePassword={(pw) => {
              onPasswordGenerated(pw);
              setShowDialog(false);
            }}
          />,
          document.body
        )}
    </>
  );
}
