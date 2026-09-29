import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { signIn } from "./plan-actions";

/** S6: signed out, and the owner tag names an account. */
export default function SignInRequiredDialog({ onCancel }: { onCancel: () => void }) {
  const signInNow = () => {
    onCancel();
    signIn();
  };
  return (
    <SyncDialogFrame
      icon="lock"
      tone="info"
      title="Sign in to open this vault"
      onEscape={onCancel}
      footer={
        <>
          <DialogButton onClick={onCancel}>Cancel</DialogButton>
          <DialogButton variant="primary" onClick={signInNow} autoFocus>
            Sign in
          </DialogButton>
        </>
      }
    >
      <p className="text-ink">This vault belongs to a Conduit account. Sign in with that account to open it.</p>
    </SyncDialogFrame>
  );
}
