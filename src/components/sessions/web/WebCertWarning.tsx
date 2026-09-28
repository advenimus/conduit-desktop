import { AlertTriangleIcon } from "../../../lib/icons";
import { Button, Card } from "../../ui";

export interface CertError {
  url: string;
  error: string;
  issuer: string;
  subject: string;
}

interface WebCertWarningProps {
  certError: CertError;
  onProceed: () => void;
}

export default function WebCertWarning({ certError, onProceed }: WebCertWarningProps) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-editor">
      <div className="max-w-lg px-8 text-center">
        <AlertTriangleIcon size={48} className="mx-auto mb-4 text-warning" />
        <h2 className="mb-2 text-title font-semibold text-ink">Your connection is not private</h2>
        <p className="mb-4 text-body text-ink-muted">
          The certificate for <span className="font-mono text-ink">{certError.url}</span> is not trusted.
        </p>
        <Card className="mb-6 space-y-1 text-left text-label text-ink-muted">
          <div>
            <span className="text-ink-faint">Error:</span> {certError.error}
          </div>
          <div>
            <span className="text-ink-faint">Issuer:</span> {certError.issuer}
          </div>
          <div>
            <span className="text-ink-faint">Subject:</span> {certError.subject}
          </div>
        </Card>
        <p className="mb-6 text-label text-ink-faint">
          This may indicate a self-signed certificate, an expired certificate, or a potential
          security risk. Only proceed if you trust this server.
        </p>
        <div className="flex justify-center gap-3">
          <Button variant="danger" onClick={onProceed}>
            Proceed Anyway
          </Button>
        </div>
        <p className="mt-3 text-label text-ink-faint">
          To always skip this warning, enable "Ignore certificate errors" in the entry settings.
        </p>
      </div>
    </div>
  );
}
