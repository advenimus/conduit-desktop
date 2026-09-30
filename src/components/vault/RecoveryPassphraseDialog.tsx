import { useState } from "react";
import { toast } from "../common/Toast";
import { Button, Checkbox, Dialog } from "../ui";

interface RecoveryPassphraseDialogProps {
  passphrase: string;
  onConfirm: () => void;
}

/**
 * Modal shown after identity key generation.
 * Displays the 6-word recovery passphrase for the user to save; it cannot be dismissed before that.
 */
export default function RecoveryPassphraseDialog({
  passphrase,
  onConfirm,
}: RecoveryPassphraseDialogProps) {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const words = passphrase.split(" ");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(passphrase);
    } catch (err) {
      console.error("[vault] Failed to copy the recovery passphrase:", err);
      toast.error("Could not copy the passphrase", "Write it down instead.");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success("Recovery passphrase copied");
  };

  return (
    <Dialog
      open
      title="Save Your Recovery Passphrase"
      icon="key"
      tone="warn"
      width={440}
      hideClose
      closeOnEscape={false}
      footer={
        <>
          <Button icon={copied ? "check" : "copy"} onClick={() => void handleCopy()}>
            {copied ? "Copied" : "Copy to Clipboard"}
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={!confirmed}>
            I've Saved It
          </Button>
        </>
      }
    >
      <div className="p-4 rounded-md bg-well border border-card-border">
        <div className="flex flex-wrap justify-center gap-2">
          {words.map((word, i) => (
            <span
              key={i}
              className="px-3 py-1.5 rounded-md bg-overlay border border-card-border text-heading font-mono text-ink"
            >
              {word}
            </span>
          ))}
        </div>
      </div>

      <p>
        Write this down and store it safely. You'll need it to access team
        vaults from new devices. This passphrase cannot be recovered if lost.
      </p>

      <Checkbox checked={confirmed} onChange={setConfirmed}>
        I have saved my recovery passphrase in a secure location
      </Checkbox>
    </Dialog>
  );
}
