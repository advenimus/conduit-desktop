import { useState } from "react";
import { invoke } from "../../lib/electron";
import { CheckIcon, CloseIcon } from "../../lib/icons";
import { Button, Callout, Card, Dialog } from "../ui";
import { errorText } from "../../lib/errorText";

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
      setError(errorText(err, "Failed to approve request"));
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
      setError(errorText(err, "Failed to deny request"));
    } finally {
      setLoading(false);
    }
  };

  const footer = result ? undefined : (
    <>
      <Button icon="close" onClick={handleDeny} disabled={loading}>
        Deny
      </Button>
      <Button variant="primary" icon="check" onClick={handleApprove} loading={loading}>
        Approve
      </Button>
    </>
  );

  return (
    <Dialog
      open
      title="Device Authorization Request"
      icon="desktop"
      width={400}
      hideClose
      closeOnEscape={false}
      onClose={onClose}
      footer={footer}
    >
      {result === "approved" && (
        <div className="flex flex-col items-center gap-3 py-6">
          <div className="flex size-12 items-center justify-center rounded-full bg-success-bg">
            <CheckIcon size={24} className="text-success" />
          </div>
          <p className="text-body text-success">Device authorized successfully</p>
        </div>
      )}

      {result === "denied" && (
        <div className="flex flex-col items-center gap-3 py-6">
          <div className="flex size-12 items-center justify-center rounded-full bg-danger-bg">
            <CloseIcon size={24} className="text-danger" />
          </div>
          <p className="text-body text-danger">Request denied</p>
        </div>
      )}

      {!result && (
        <>
          <p className="text-body text-ink-secondary">
            A new device is requesting access to your team vault keys. Only
            approve if you initiated this from another device.
          </p>

          <Card className="flex items-center gap-2 text-body">
            <span className="text-ink-muted">Device:</span>
            <span className="font-medium text-ink">{deviceName}</span>
          </Card>

          {error && <Callout tone="danger">{error}</Callout>}
        </>
      )}
    </Dialog>
  );
}
