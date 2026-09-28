import { Button, Dialog } from "../ui";

interface BiometricSetupPromptProps {
  onDismiss: () => void;
  onAccept: () => void;
}

/** Offered after the first password unlock of a vault. Escape dismisses it like Not Now. */
export default function BiometricSetupPrompt({ onDismiss, onAccept }: BiometricSetupPromptProps) {
  return (
    <Dialog
      open
      title="Enable Quick Unlock"
      icon="fingerprint"
      width={384}
      hideClose
      onClose={onDismiss}
      footer={
        <>
          <Button onClick={onDismiss}>Not Now</Button>
          <Button variant="primary" onClick={onAccept}>
            Enable
          </Button>
        </>
      }
    >
      <p className="text-ink-muted">
        Unlock this vault faster next time with Touch ID, Apple Watch, or your system password.
      </p>
    </Dialog>
  );
}
