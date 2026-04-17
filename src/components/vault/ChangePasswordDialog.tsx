import { useState } from "react";
import { invoke } from "../../lib/electron";
import { toast } from "../common/Toast";
import {
  AlertCircleIcon, EyeIcon, EyeOffIcon, LoaderIcon, LockIcon
} from "../../lib/icons";

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
      await invoke("vault_change_password", { currentPassword, newPassword });
      toast.success("Vault password changed successfully");
      onClose();
    } catch (err) {
      const msg = typeof err === "string" ? err : "Failed to change password";
      setError(msg);
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-dialog-content className="bg-panel border border-stroke rounded-lg shadow-xl w-[420px] p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-conduit-500/10 flex items-center justify-center">
            <LockIcon size={20} className="text-conduit-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-ink">Change Password</h2>
            <p className="text-xs text-ink-muted">
              Update the master password for this vault
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Current Password */}
          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1.5">
              Current Password
            </label>
            <div className="relative">
              <input
                type={showCurrent ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                  setError(null);
                }}
                placeholder="Enter current password"
                className="w-full px-3 py-2 pr-9 rounded-md bg-well border border-stroke text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-conduit-500/50"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowCurrent(!showCurrent)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink-muted transition-colors"
                tabIndex={-1}
              >
                {showCurrent ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
              </button>
            </div>
          </div>

          {/* New Password */}
          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1.5">
              New Password
            </label>
            <div className="relative">
              <input
                type={showNew ? "text" : "password"}
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  setError(null);
                }}
                placeholder="Enter new password"
                className="w-full px-3 py-2 pr-9 rounded-md bg-well border border-stroke text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-conduit-500/50"
              />
              <button
                type="button"
                onClick={() => setShowNew(!showNew)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink-muted transition-colors"
                tabIndex={-1}
              >
                {showNew ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
              </button>
            </div>
            {passwordTooShort && (
              <p className="text-xs text-amber-400 mt-1">
                Password must be at least {MIN_PASSWORD_LENGTH} characters
              </p>
            )}
          </div>

          {/* Confirm New Password */}
          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1.5">
              Confirm New Password
            </label>
            <div className="relative">
              <input
                type={showConfirm ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  setError(null);
                }}
                placeholder="Confirm new password"
                className="w-full px-3 py-2 pr-9 rounded-md bg-well border border-stroke text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-conduit-500/50"
              />
              <button
                type="button"
                onClick={() => setShowConfirm(!showConfirm)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink-muted transition-colors"
                tabIndex={-1}
              >
                {showConfirm ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
              </button>
            </div>
            {passwordsMismatch && (
              <p className="text-xs text-amber-400 mt-1">
                Passwords do not match
              </p>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20">
              <AlertCircleIcon
                size={16}
                className="text-red-400 mt-0.5 flex-shrink-0"
              />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-ink-muted hover:text-ink rounded-md hover:bg-raised transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!isValid || loading}
              className="px-4 py-2 text-sm bg-conduit-600 text-white rounded-md hover:bg-conduit-500 transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {loading && <LoaderIcon size={14} className="animate-spin" />}
              Change Password
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
