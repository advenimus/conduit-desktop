import { useState } from "react";
import type { OpenErrorPayload } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { InlineError, PasswordField } from "./PasswordFields";
import { Checkbox } from "../ui";
import { deviceNameOr, formatAgo } from "./sync-copy";

type PasswordChanged = Extract<OpenErrorPayload, { code: "VAULT_PASSWORD_CHANGED_ELSEWHERE" }>;

/** "The master password was changed on MacBook 2 hours ago." */
export function passwordChangedText(changedByDeviceName: string | null, changedMs: number, nowMs = Date.now()): string {
  const who = deviceNameOr(changedByDeviceName);
  const when = changedMs > 0 ? ` ${formatAgo(changedMs, nowMs)}` : "";
  return `The master password was changed on ${who}${when}.`;
}

interface PasswordChangedElsewhereDialogProps {
  payload: PasswordChanged;
  busy: boolean;
  error: string | null;
  /** The startup vault's saved unlock failed (docs/AUTO_UNLOCK.md 3.6): main supplies the previous password. */
  savedUnlockName?: string | null;
  onSubmit: (newPassword: string, previousPassword: string | null, keepAutoUnlock?: boolean) => void;
  onCancel: () => void;
}

/** Unlock-time 4.8: the typed password is an old one. Unlock again with the new one. */
export default function PasswordChangedElsewhereDialog({
  payload,
  busy,
  error,
  savedUnlockName = null,
  onSubmit,
  onCancel,
}: PasswordChangedElsewhereDialogProps) {
  const [password, setPassword] = useState("");
  const [previous, setPrevious] = useState("");
  const [keep, setKeep] = useState(true);
  const fromSavedUnlock = savedUnlockName !== null;
  const needsPrevious = payload.needsPreviousPassword && !fromSavedUnlock;
  const canSubmit = password.length > 0 && (!needsPrevious || previous.length > 0) && !busy;
  const submit = () => {
    if (!canSubmit) return;
    if (fromSavedUnlock) onSubmit(password, null, keep);
    else onSubmit(password, needsPrevious ? previous : null);
  };

  return (
    <SyncDialogFrame
      icon="key"
      tone="warn"
      title="Master password changed"
      onEscape={onCancel}
      onSubmit={submit}
      footer={
        <>
          <DialogButton onClick={onCancel} disabled={busy}>Cancel</DialogButton>
          <DialogButton type="submit" variant="primary" disabled={!canSubmit} loading={busy} loadingLabel="Unlocking...">
            Unlock
          </DialogButton>
        </>
      }
    >
      {fromSavedUnlock && <p className="text-ink">Conduit couldn't open {savedUnlockName} automatically.</p>}
      <p className="text-ink">{passwordChangedText(payload.changedByDeviceName, payload.changedMs)}</p>
      <p>
        {needsPrevious
          ? "Enter the new password and your previous one, so changes made on this device are kept."
          : "Enter the new password to unlock."}
      </p>
      <PasswordField label="New master password" value={password} onChange={setPassword} autoFocus />
      {needsPrevious && <PasswordField label="Previous master password" value={previous} onChange={setPrevious} />}
      {payload.deleteBiometric && (
        <p className="text-label text-ink-muted">Quick Unlock was turned off for this vault. Turn it on again in Settings.</p>
      )}
      {fromSavedUnlock && (
        <Checkbox checked={keep} onChange={setKeep} description="Saves the password you enter now.">
          <span className="font-medium text-ink">Keep unlocking automatically at startup</span>
        </Checkbox>
      )}
      <InlineError message={error} />
    </SyncDialogFrame>
  );
}
