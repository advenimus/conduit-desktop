import { useState, useEffect, useRef } from "react";
import { useVaultStore, type UnlockOptions } from "../../stores/vaultStore";
import { useAuthStore } from "../../stores/authStore";
import { useAiStore } from "../../stores/aiStore";
import { useSyncStore } from "../../stores/syncStore";
import { invoke } from "../../lib/electron";
import { errorText } from "../../lib/errorText";
import { toast } from "../common/Toast";
import UnlockErrorView, { openErrorLine, type UnlockRetry } from "../sync/UnlockErrorView";
import { useForgetUnlockRequestOnClose } from "../sync/useForgetUnlockRequest";
import BiometricSetupPrompt from "./BiometricSetupPrompt";
import AutoUnlockWarningDialog from "./AutoUnlockWarningDialog";
import { AutoUnlockCheckbox, AutoUnlockFallbackNote } from "./AutoUnlockFields";
import { useAutoUnlockChoice } from "./useAutoUnlockChoice";
import { useStartupVaultStore } from "../../stores/startupVaultStore";
import { toastStartupOpenCancelled, turnOffAutoUnlock } from "../../lib/startup-vault";
import { CloudIcon } from "../../lib/icons";
import { Button, Callout, Checkbox, Dialog, FormField, IconButton, TextInput } from "../ui";

/** "saved": the startup vault's automatic attempt, and every retry or typed password in its fallback. */
type AttemptKind = "password" | "biometric" | "saved";

const SAVED_UNLOCK_UNAVAILABLE = "Conduit couldn't use the saved unlock. Enter your master password.";

interface UnlockDialogProps {
  onSuccess: () => void;
  onCancel: () => void;
}

export default function UnlockDialog({ onSuccess, onCancel }: UnlockDialogProps) {
  const {
    vaultExists,
    currentVaultPath,
    initializeVault,
    unlockVault,
    enableCloudSync,
    isLoading,
    error,
    clearError,
    biometricAvailable,
    biometricEnabled,
    biometricUnlockInProgress,
    biometricUnlock,
    enableBiometric,
    checkBiometric,
  } = useVaultStore();
  const { isAuthenticated } = useAuthStore();
  const cloudBackupAllowed = useAiStore((s) => s.tierCapabilities?.cloud_sync_enabled ?? false);
  const openError = useSyncStore((s) => s.openError);
  const takeoverMode = useSyncStore((s) => s.takeoverMode);
  const fallback = useStartupVaultStore((s) => s.fallback);
  const autoUnlock = useStartupVaultStore((s) => s.autoUnlock);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [cloudBackup, setCloudBackup] = useState(true);
  const [showBiometricSetup, setShowBiometricSetup] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);
  const [lineRetryable, setLineRetryable] = useState(false);
  const [showAutoWarning, setShowAutoWarning] = useState(false);
  const [touchIdSettled, setTouchIdSettled] = useState(false);
  const biometricTriggered = useRef(false);
  const attemptRef = useRef<AttemptKind>(fallback ? "saved" : "password");
  const lastOptsRef = useRef<UnlockOptions>({});

  const isInitializing = !vaultExists;
  const autoTouchId = !isInitializing && biometricAvailable && biometricEnabled && fallback === null;
  const choice = useAutoUnlockChoice({ isInitializing, touchIdPending: biometricUnlockInProgress || (autoTouchId && !touchIdSettled) });

  // Structured errors without a dialog become the error line.
  useEffect(() => {
    if (!openError) return;
    const line = openErrorLine(openError);
    if (line) {
      setLineError(line);
      setLineRetryable(openError.code === "VAULT_FILE_UNREADABLE" && attemptRef.current === "saved");
      useSyncStore.getState().setOpenError(null);
    }
  }, [openError]);

  const succeed = () => {
    useStartupVaultStore.getState().setFallback(null);
    onSuccess();
  };

  const cancel = () => {
    const f = useStartupVaultStore.getState().fallback;
    useStartupVaultStore.getState().setFallback(null);
    onCancel();
    if (f) toastStartupOpenCancelled(f.name, f.kind);
  };

  /** After any successful unlock: the warning when the checkbox asks for it, else done. */
  const finishUnlock = async (offerBiometric: boolean): Promise<void> => {
    if ((await choice.afterUnlock()) === "warning") {
      setShowAutoWarning(true);
      return;
    }
    if (offerBiometric && (await offerBiometricSetup())) return;
    succeed();
  };

  useForgetUnlockRequestOnClose();

  const runUnlock = async (kind: AttemptKind, pw: string, opts: UnlockOptions) => {
    attemptRef.current = kind;
    lastOptsRef.current = opts;
    const merged: UnlockOptions = useSyncStore.getState().takeoverMode ? { ...opts, takeover: true } : opts;
    if (kind === "biometric") await biometricUnlock(merged);
    else if (kind === "saved") {
      const res = await autoUnlock({ ...merged, password: pw || undefined });
      if (!res.ok) {
        useStartupVaultStore.getState().setFallback(null);
        attemptRef.current = "password";
        useVaultStore.setState({ error: SAVED_UNLOCK_UNAVAILABLE });
        throw new Error(SAVED_UNLOCK_UNAVAILABLE);
      }
    } else await unlockVault(pw, merged);
  };

  // Auto-trigger biometric on mount when available and enabled, never over an automatic attempt's fallback
  useEffect(() => {
    if (autoTouchId && !biometricTriggered.current) {
      biometricTriggered.current = true;
      void handleBiometricUnlock().finally(() => setTouchIdSettled(true));
    }
    // eslint-disable-next-line
  }, [autoTouchId]);

  // Re-check biometric status when dialog opens
  useEffect(() => {
    checkBiometric();
    // eslint-disable-next-line
  }, []);

  const handleBiometricUnlock = async () => {
    clearError();
    setLineError(null);
    try {
      await runUnlock("biometric", "", {});
      await finishUnlock(false);
    } catch {
      // Cancelled or failed: stay on the dialog (sync errors open their own dialog)
    }
  };

  const offerBiometricSetup = async (): Promise<boolean> => {
    try {
      const [available, shouldPrompt] = await Promise.all([
        invoke<boolean>("biometric_available"),
        invoke<boolean>("biometric_should_prompt"),
      ]);
      if (available && shouldPrompt) {
        setShowBiometricSetup(true);
        return true;
      }
    } catch {
      // Check failed: skip the setup prompt
    }
    return false;
  };

  const handleRetry = async (retry: UnlockRetry) => {
    const previousError = useSyncStore.getState().openError;
    setRetrying(true);
    setRetryError(null);
    try {
      if (retry.password !== null) setPassword(retry.password);
      const saved = attemptRef.current === "saved";
      const kind: AttemptKind = saved ? "saved" : retry.password !== null ? "password" : attemptRef.current;
      // A take-over or rebuild repeats the last attempt, keeping its previous password.
      const opts = retry.password !== null ? retry.opts : { ...lastOptsRef.current, ...retry.opts };
      await runUnlock(kind, retry.password ?? password, opts);
      if (saved && retry.keepAutoUnlock !== undefined) {
        await choice.afterSavedPasswordChanged(retry.keepAutoUnlock);
        succeed();
        return;
      }
      await finishUnlock(kind === "password");
    } catch {
      const sync = useSyncStore.getState();
      if (sync.openError === null && previousError?.code === "VAULT_PASSWORD_CHANGED_ELSEWHERE") {
        sync.setOpenError(previousError);
        setRetryError(useVaultStore.getState().error ?? "That password didn't work.");
      }
    } finally {
      setRetrying(false);
    }
  };

  const handleErrorCancel = () => {
    useSyncStore.getState().setOpenError(null);
    setPassword("");
    setRetryError(null);
    // A gate dialog of the startup vault's automatic attempt closes the whole dialog (spec 2.1).
    if (attemptRef.current === "saved") cancel();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setLineError(null);

    if (isInitializing && password !== confirmPassword) {
      return;
    }

    try {
      if (isInitializing) {
        await initializeVault(password);
        if (cloudBackup && showCloudBackupOption) {
          try {
            await enableCloudSync();
          } catch (err) {
            console.error("[vault] Failed to enable cloud backup:", err);
            toast.error("Could not turn on cloud backup", errorText(err, "Try again in Settings > Backup."));
          }
        }
      } else {
        await runUnlock(fallback ? "saved" : "password", password, {});
        await finishUnlock(true);
        return;
      }

      succeed();
    } catch {
      // Error is set in the store
    }
  };

  const handleBiometricSetupAccept = async () => {
    try {
      await enableBiometric();
    } catch (err) {
      console.error("Failed to enable biometric:", err);
    }
    succeed();
  };

  const handleBiometricSetupDismiss = async () => {
    // Mark prompt as dismissed for this specific vault
    try {
      await invoke("biometric_dismiss_prompt");
    } catch {
      // Best-effort
    }
    succeed();
  };

  const passwordsMatch = !isInitializing || password === confirmPassword;
  const canSubmit = password.length > 0 && passwordsMatch && !isLoading && !biometricUnlockInProgress;
  const showCloudBackupOption = isAuthenticated && cloudBackupAllowed;
  const shownError = lineError ?? error;

  if (showAutoWarning) {
    return <AutoUnlockWarningDialog mode="after-unlock" onClose={() => succeed()} />;
  }

  if (openError && !openErrorLine(openError)) {
    return (
      <UnlockErrorView
        payload={openError}
        busy={retrying || isLoading || biometricUnlockInProgress}
        error={retryError}
        savedUnlockName={attemptRef.current === "saved" ? (fallback?.name ?? null) : null}
        onRetry={(retry) => void handleRetry(retry)}
        onCancel={handleErrorCancel}
      />
    );
  }

  // Biometric setup prompt (shown after first successful password unlock)
  if (showBiometricSetup) {
    return (
      <BiometricSetupPrompt
        onDismiss={handleBiometricSetupDismiss}
        onAccept={handleBiometricSetupAccept}
      />
    );
  }

  const passwordType = showPassword ? "text" : "password";
  const confirmMismatch = confirmPassword.length > 0 && !passwordsMatch;

  return (
    <Dialog
      open
      title={isInitializing ? "Create Vault" : "Unlock Vault"}
      icon="lock"
      width={384}
      hideClose
      onClose={cancel}
      onSubmit={(e) => void handleSubmit(e)}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!canSubmit} loading={isLoading} loadingLabel="Please wait...">
            {isInitializing ? "Create Vault" : "Unlock"}
          </Button>
        </>
      }
    >
      <div className="space-y-1">
        {currentVaultPath && (
          <p className="text-meta text-ink-faint truncate" title={currentVaultPath}>
            {currentVaultPath.split(/[/\\]/).pop()}
          </p>
        )}
        {choice.keepMode ? (
          <AutoUnlockFallbackNote
            onTurnOff={() => {
              const name = fallback?.name ?? "";
              useStartupVaultStore.getState().setFallback(null);
              void turnOffAutoUnlock(name);
            }}
          />
        ) : (
          <p className="text-body text-ink-muted">
            {isInitializing
              ? "Set a master password to protect your credentials"
              : biometricUnlockInProgress
              ? "Authenticating..."
              : takeoverMode
              ? "Unlock to use this vault here. It locks on the other device."
              : (choice.afterLockLine ?? "Enter your master password to access credentials")}
          </p>
        )}
      </div>

      <FormField label="Master Password">
        <TextInput
          type={passwordType}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter master password"
          autoFocus={!biometricEnabled}
          disabled={biometricUnlockInProgress}
          trailing={
            <IconButton
              size="sm"
              icon={showPassword ? "eyeOff" : "eye"}
              label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword(!showPassword)}
            />
          }
        />
      </FormField>

      {!isInitializing && biometricAvailable && biometricEnabled && (
        <Button icon="fingerprint" fullWidth size="lg" onClick={handleBiometricUnlock} disabled={biometricUnlockInProgress}>
          {biometricUnlockInProgress ? "Authenticating..." : "Quick Unlock"}
        </Button>
      )}

      {isInitializing && (
        <>
          <FormField label="Confirm Password" error={confirmMismatch ? "Passwords do not match" : undefined}>
            <TextInput
              type={passwordType}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm master password"
              invalid={confirmMismatch}
            />
          </FormField>
          {showCloudBackupOption && (
            <Checkbox
              checked={cloudBackup}
              onChange={setCloudBackup}
              description="End-to-end encrypted with AES-256-GCM. Your master password never leaves this device."
            >
              <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                <CloudIcon size={16} className="text-info" />
                Back up to the cloud
              </span>
            </Checkbox>
          )}
        </>
      )}

      {choice.showCheckbox && <AutoUnlockCheckbox keepMode={choice.keepMode} checked={choice.checked} onChange={choice.setChecked} />}

      {shownError && (
        <Callout
          tone="danger"
          actions={
            lineRetryable && lineError ? (
              <Button variant="link" size="sm" onClick={() => void handleRetry({ password: null, opts: {} })} disabled={retrying}>
                Try Again
              </Button>
            ) : undefined
          }
        >
          {shownError}
        </Callout>
      )}
    </Dialog>
  );
}
