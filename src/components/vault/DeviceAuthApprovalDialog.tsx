import { useState } from "react";
import { invoke } from "../../lib/electron";
import { CheckIcon, CloseIcon, DesktopIcon, LoaderIcon } from "../../lib/icons";

interface DeviceAuthApprovalDialogProps {
  requestId: string;
  deviceName: string;
  onClose: () => void;
}

/**
 * Dialog shown on an existing device when another device requests authorization.
 * The user can approve or deny the request.
 */
export default function DeviceAuthApprovalDialog({
  requestId,
  deviceName,
  onClose,
}: DeviceAuthApprovalDialogProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleApprove = async () => {
    setLoading(true);
    setError(null);
    try {
      await invoke("device_auth_approve", { requestId });
      setResult("approved");
      setTimeout(onClose, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve request");
    } finally {
      setLoading(false);
    }
  };

  const handleDeny = async () => {
    setLoading(true);
    setError(null);
    try {
      await invoke("device_auth_deny", { requestId });
      setResult("denied");
      setTimeout(onClose, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to deny request");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-dialog-content className="bg-panel border border-stroke rounded-lg shadow-xl w-[400px] p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-conduit-500/10 flex items-center justify-center">
            <DesktopIcon size={20} className="text-conduit-400" />
          </div>
          <h2 className="text-lg font-semibold text-ink">
            Device Authorization Request
          </h2>
        </div>

        {/* Result state */}
        {result === "approved" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center">
              <CheckIcon size={24} className="text-green-400" />
            </div>
            <p className="text-sm text-green-400">
              Device authorized successfully
            </p>
          </div>
        )}

        {result === "denied" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center">
              <CloseIcon size={24} className="text-red-400" />
            </div>
            <p className="text-sm text-red-400">Request denied</p>
          </div>
        )}

        {/* Pending state */}
        {!result && (
          <>
            <p className="text-sm text-ink-secondary mb-4">
              A new device is requesting access to your team vault keys. Only
              approve if you initiated this from another device.
            </p>

            <div className="p-3 rounded-md bg-well border border-stroke mb-5">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-ink-muted">
                  Device:
                </span>
                <span className="text-ink font-medium">
                  {deviceName}
                </span>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20 mb-4">
                <p className="text-sm text-red-300">{error}</p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={handleDeny}
                disabled={loading}
                className="px-4 py-2 text-sm text-red-400 hover:text-red-300 rounded-md hover:bg-red-500/10 transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                <CloseIcon size={14} />
                Deny
              </button>
              <button
                onClick={handleApprove}
                disabled={loading}
                className="px-4 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-500 transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                {loading ? (
                  <LoaderIcon size={14} className="animate-spin" />
                ) : (
                  <CheckIcon size={14} />
                )}
                Approve
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
