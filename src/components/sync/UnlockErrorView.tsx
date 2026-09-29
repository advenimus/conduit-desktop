import type { OpenErrorPayload } from "../../types/sync";
import type { UnlockOptions } from "../../stores/vault-unlock-errors";
import TakeoverDialog from "./TakeoverDialog";
import PasswordChangedElsewhereDialog from "./PasswordChangedElsewhereDialog";
import DamagedWorkingCopyDialog from "./DamagedWorkingCopyDialog";
import NotOwnerDialog from "./NotOwnerDialog";
import SignInRequiredDialog from "./SignInRequiredDialog";
import UpdateRequiredDialog from "./UpdateRequiredDialog";

/** One-line text for structured errors that need no dialog, else null. */
export function openErrorLine(payload: OpenErrorPayload): string | null {
  switch (payload.code) {
    case "VAULT_FILE_UNREADABLE":
      return `Conduit can't read '${payload.fileName}' right now. If it is still downloading, wait a moment and try again.`;
    case "VAULT_FOREIGN_FILE":
      return payload.kind === "newer-format"
        ? `'${payload.fileName}' was saved by a newer version of Conduit. Update Conduit to open it.`
        : `'${payload.fileName}' is a different vault, or not a Conduit vault.`;
    default:
      return null;
  }
}

export interface UnlockRetry {
  readonly password: string | null;
  readonly opts: UnlockOptions;
  /** The password-changed dialog of an automatic unlock: keep unlocking automatically with the new password. */
  readonly keepAutoUnlock?: boolean;
}

interface UnlockErrorViewProps {
  payload: OpenErrorPayload;
  busy: boolean;
  error: string | null;
  /** The startup vault's automatic unlock failed; its name. */
  savedUnlockName?: string | null;
  onRetry: (retry: UnlockRetry) => void;
  onCancel: () => void;
}

/** The dialog for a structured unlock error; the unlock dialog keeps the typed password. */
export default function UnlockErrorView({ payload, busy, error, savedUnlockName = null, onRetry, onCancel }: UnlockErrorViewProps) {
  switch (payload.code) {
    case "VAULT_OPEN_ELSEWHERE":
      return (
        <TakeoverDialog
          payload={payload}
          busy={busy}
          onUseHere={() => onRetry({ password: null, opts: { takeover: true } })}
          onCancel={onCancel}
        />
      );
    case "VAULT_PASSWORD_CHANGED_ELSEWHERE":
      return (
        <PasswordChangedElsewhereDialog
          payload={payload}
          busy={busy}
          error={error}
          savedUnlockName={savedUnlockName}
          onSubmit={(password, previousPassword, keepAutoUnlock) =>
            onRetry({ password, opts: previousPassword ? { previousPassword } : {}, keepAutoUnlock })
          }
          onCancel={onCancel}
        />
      );
    case "VAULT_WORKING_COPY_DAMAGED":
      return (
        <DamagedWorkingCopyDialog
          fileName={payload.fileName}
          recoverable={payload.recoverable}
          busy={busy}
          onRecover={() => onRetry({ password: null, opts: { recoverWorkingCopy: true } })}
          onCancel={onCancel}
        />
      );
    case "VAULT_NOT_OWNER":
      return <NotOwnerDialog payload={payload} onCancel={onCancel} />;
    case "VAULT_SIGN_IN_REQUIRED":
      return <SignInRequiredDialog onCancel={onCancel} />;
    case "VAULT_UPDATE_REQUIRED":
      return <UpdateRequiredDialog minVersion={payload.minVersion} onCancel={onCancel} />;
    default:
      return null;
  }
}
