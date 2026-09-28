import { useState, useEffect, useRef } from "react";
import { useVaultStore, type UnlockOptions } from "../../stores/vaultStore";
import { useAuthStore } from "../../stores/authStore";
import { useAiStore } from "../../stores/aiStore";
import { useSyncStore } from "../../stores/syncStore";
import { invoke } from "../../lib/electron";
import { errorText } from "../../lib/sync-api";
import { toast } from "../common/Toast";
import UnlockErrorView, { openErrorLine, type UnlockRetry } from "../sync/UnlockErrorView";
import { useForgetUnlockRequestOnClose } from "../sync/useForgetUnlockRequest";
import BiometricSetupPrompt from "./BiometricSetupPrompt";
import { CloudIcon } from "../../lib/icons";
import { Button, Callout, Checkbox, Dialog, FormField, IconButton, TextInput } from "../ui";

type AttemptKind = "password" | "biometric";

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
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [cloudBackup, setCloudBackup] = useState(true);
  const [showBiometricSetup, setShowBiometricSetup] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);
  const biometricTriggered = useRef(false);
  const attemptRef = useRef<AttemptKind>("password");
  const lastOptsRef = useRef<UnlockOptions>({});

  const isInitializing = !vaultExists;

  // Structured errors without a dialog become the error line.
  useEffect(() => {
    if (!openError) return;
    const line = openErrorLine(openError);
    if (line) {
      setLineError(line);
      useSyncStore.getState().setOpenError(null);
    }
  }, [openError]);

  useForgetUnlockRequestOnClose();

  const runUnlock = async (kind: AttemptKind, pw: string, opts: UnlockOptions) => {
    attemptRef.current = kind;
    lastOptsRef.current = opts;
    const merged: UnlockOptions = useSyncStore.getState().takeoverMode ? { ...opts, takeover: true } : opts;
    if (kind === "biometric") await biometricUnlock(merged);
    else await unlockVault(pw, merged);
  };

  // Auto-trigger biometric on mount when available and enabled
  useEffect(() => {
    if (
      !isInitializing &&
      biometricAvailable &&
      biometricEnabled &&
      !biometricTriggered.current
    ) {
      biometricTriggered.current = true;
      handleBiometricUnlock();
    }
    // eslint-disable-next-line
  }, [biometricAvailable, biometricEnabled, isInitializing]);

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
      onSuccess();
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
      const kind: AttemptKind = retry.password !== null ? "password" : attemptRef.current;
      // A take-over or rebuild repeats the last attempt, keeping its previous password.
      const opts = retry.password !== null ? retry.opts : { ...lastOptsRef.current, ...retry.opts };
      await runUnlock(kind, retry.password ?? password, opts);
      if (kind === "password" && (await offerBiometricSetup())) return;
      onSuccess();
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
        await runUnlock("password", password, {});
        if (await offerBiometricSetup()) return;
      }

      onSuccess();
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
    onSuccess();
  };

  const handleBiometricSetupDismiss = async () => {
    // Mark prompt as dismissed for this specific vault
    try {
      await invoke("biometric_dismiss_prompt");
    } catch {
      // Best-effort
    }
    onSuccess();
  };

  const passwordsMatch = !isInitializing || password === confirmPassword;
  const canSubmit = password.length > 0 && passwordsMatch && !isLoading && !biometricUnlockInProgress;
  const showCloudBackupOption = isAuthenticated && cloudBackupAllowed;
  const shownError = lineError ?? error;

  if (openError && !openErrorLine(openError)) {
    return (
      <UnlockErrorView
        payload={openError}
        busy={retrying || isLoading || biometricUnlockInProgress}
        error={retryError}
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
      onClose={onCancel}
      onSubmit={(e) => void handleSubmit(e)}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
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
        <p className="text-body text-ink-muted">
          {isInitializing
            ? "Set a master password to protect your credentials"
            : biometricUnlockInProgress
            ? "Authenticating..."
            : takeoverMode
            ? "Unlock to use this vault here. It locks on the other device."
            : "Enter your master password to access credentials"}
        </p>
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

      {shownError && <Callout tone="danger">{shownError}</Callout>}
    </Dialog>
  );
}
