import { useState } from "react";
import PasswordGeneratorDialog from "./PasswordGeneratorDialog";
import { IconButton } from "../ui";

interface PasswordGenerateButtonProps {
  onPasswordGenerated: (password: string) => void;
}

export default function PasswordGenerateButton({
  onPasswordGenerated,
}: PasswordGenerateButtonProps) {
  const [showDialog, setShowDialog] = useState(false);

  return (
    <>
      <IconButton size="sm" icon="key" label="Password Generator" onClick={() => setShowDialog(true)} />
      {showDialog && (
        <PasswordGeneratorDialog
          onClose={() => setShowDialog(false)}
          onUsePassword={(pw) => {
            onPasswordGenerated(pw);
            setShowDialog(false);
          }}
        />
      )}
    </>
  );
}
