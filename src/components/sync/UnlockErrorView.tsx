import type { OpenErrorPayload } from "../../types/sync";
import type { UnlockOptions } from "../../stores/vault-unlock-errors";
import TakeoverDialog from "./TakeoverDialog";
import PasswordChangedElsewhereDialog from "./PasswordChangedElsewhereDialog";
import DamagedWorkingCopyDialog from "./DamagedWorkingCopyDialog";

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
}

interface UnlockErrorViewProps {
  payload: OpenErrorPayload;
  busy: boolean;
  error: string | null;
  onRetry: (retry: UnlockRetry) => void;
  onCancel: () => void;
}

/** The dialog for a structured unlock error; the unlock dialog keeps the typed password. */
export default function UnlockErrorView({ payload, busy, error, onRetry, onCancel }: UnlockErrorViewProps) {
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
          onSubmit={(password, previousPassword) =>
            onRetry({ password, opts: previousPassword ? { previousPassword } : {} })
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
    default:
      return null;
  }
}
