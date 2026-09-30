import { useState } from "react";
import { KeyIcon } from "../../lib/icons";
import type { OpenErrorPayload } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { InlineError, PasswordInput } from "./PasswordFields";
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
  onSubmit: (newPassword: string, previousPassword: string | null) => void;
  onCancel: () => void;
}

/** Unlock-time 4.8: the typed password is an old one. Unlock again with the new one. */
export default function PasswordChangedElsewhereDialog({
  payload,
  busy,
  error,
  onSubmit,
  onCancel,
}: PasswordChangedElsewhereDialogProps) {
  const [password, setPassword] = useState("");
  const [previous, setPrevious] = useState("");
  const needsPrevious = payload.needsPreviousPassword;
  const canSubmit = password.length > 0 && (!needsPrevious || previous.length > 0) && !busy;
  const submit = () => {
    if (canSubmit) onSubmit(password, needsPrevious ? previous : null);
  };

  return (
    <SyncDialogFrame
      icon={KeyIcon}
      tone="warn"
      title="Master password changed"
      onEscape={onCancel}
      footer={
        <>
          <DialogButton onClick={onCancel} disabled={busy}>Cancel</DialogButton>
          <DialogButton variant="primary" onClick={submit} disabled={!canSubmit}>
            {busy ? "Unlocking..." : "Unlock"}
          </DialogButton>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="text-ink">{passwordChangedText(payload.changedByDeviceName, payload.changedMs)}</p>
        <p>
          {needsPrevious
            ? "Enter the new password and your previous one, so changes made on this device are kept."
            : "Enter the new password to unlock."}
        </p>
        <PasswordInput label="New master password" value={password} onChange={setPassword} autoFocus />
        {needsPrevious && <PasswordInput label="Previous master password" value={previous} onChange={setPrevious} />}
        {payload.deleteBiometric && (
          <p className="text-xs text-ink-muted">Quick Unlock was turned off for this vault. Turn it on again in Settings.</p>
        )}
        <InlineError message={error} />
        <button type="submit" hidden aria-hidden />
      </form>
    </SyncDialogFrame>
  );
}
