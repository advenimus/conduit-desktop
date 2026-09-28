import { useState } from "react";
import { invoke } from "../../lib/electron";
import { useSyncStore } from "../../stores/syncStore";
import { toast } from "../common/Toast";
import { Button, Callout, Checkbox, Dialog, FormField, IconButton, TextInput } from "../ui";

interface ChangePasswordDialogProps {
  onClose: () => void;
}

const MIN_PASSWORD_LENGTH = 8;

export default function ChangePasswordDialog({ onClose }: ChangePasswordDialogProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eraseDeleted, setEraseDeleted] = useState(false);
  // Only the sync engine's password change can erase graves (spec 4.7, 4.8 step 6).
  const engineSync = useSyncStore((s) => s.state?.vault?.engine === true);

  const passwordTooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;
  const passwordsMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const isValid =
    currentPassword.length > 0 &&
    newPassword.length >= MIN_PASSWORD_LENGTH &&
    newPassword === confirmPassword;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    setLoading(true);
    setError(null);

    try {
      await invoke("vault_change_password", {
        currentPassword,
        newPassword,
        eraseRecentlyDeleted: engineSync && eraseDeleted,
      });
      toast.success("Vault password changed successfully");
      onClose();
    } catch (err) {
      const msg = typeof err === "string" ? err : "Failed to change password";
      setError(msg);
      setLoading(false);
    }
  };

  return (
    <Dialog
      open
      title="Change Password"
      icon="lock"
      width={420}
      hideClose
      closeOnEscape={false}
      onClose={onClose}
      onSubmit={(e) => void handleSubmit(e)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!isValid} loading={loading}>
            Change Password
          </Button>
        </>
      }
    >
      <p className="text-ink-muted">Update the master password for this vault</p>

      <FormField label="Current Password">
        <PasswordField
          value={currentPassword}
          onChange={(value) => {
            setCurrentPassword(value);
            setError(null);
          }}
          placeholder="Enter current password"
          shown={showCurrent}
          onToggle={() => setShowCurrent(!showCurrent)}
          autoFocus
        />
      </FormField>

      <FormField
        label="New Password"
        description={
          passwordTooShort ? <span className="text-warning">Password must be at least {MIN_PASSWORD_LENGTH} characters</span> : undefined
        }
      >
        <PasswordField
          value={newPassword}
          onChange={(value) => {
            setNewPassword(value);
            setError(null);
          }}
          placeholder="Enter new password"
          shown={showNew}
          onToggle={() => setShowNew(!showNew)}
        />
      </FormField>

      <FormField
        label="Confirm New Password"
        description={passwordsMismatch ? <span className="text-warning">Passwords do not match</span> : undefined}
      >
        <PasswordField
          value={confirmPassword}
          onChange={(value) => {
            setConfirmPassword(value);
            setError(null);
          }}
          placeholder="Confirm new password"
          shown={showConfirm}
          onToggle={() => setShowConfirm(!showConfirm)}
        />
      </FormField>

      {engineSync && (
        <Checkbox checked={eraseDeleted} onChange={setEraseDeleted} className="text-label text-ink-muted">
          Also permanently delete items in Recently deleted, on every device. Recommended if your old
          password may have leaked.
        </Checkbox>
      )}

      {error && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}

interface PasswordFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  shown: boolean;
  onToggle: () => void;
  autoFocus?: boolean;
}

function PasswordField({ value, onChange, placeholder, shown, onToggle, autoFocus }: PasswordFieldProps) {
  return (
    <TextInput
      type={shown ? "text" : "password"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      trailing={
        <IconButton
          size="sm"
          icon={shown ? "eyeOff" : "eye"}
          label={shown ? "Hide password" : "Show password"}
          onClick={onToggle}
          tabIndex={-1}
        />
      }
    />
  );
}
