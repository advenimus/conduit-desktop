import { useEffect, useState } from "react";
import { ShieldLockIcon, TrashIcon } from "../../../lib/icons";
import { Button, Card, TextInput } from "../../ui";
import { toast } from "../../common/Toast";
import { invoke } from "../../../lib/electron";
import { generateTotpCode } from "../../../lib/totp";
import Field from "../Field";
import { errorText } from "../../../lib/errorText";

export interface TotpSectionProps {
  totpSecret?: string;
  setTotpSecret?: (v: string) => void;
  totpIssuer?: string;
  setTotpIssuer?: (v: string) => void;
  totpLabel?: string;
  setTotpLabel?: (v: string) => void;
  totpAlgorithm?: string;
  setTotpAlgorithm?: (v: string) => void;
  totpDigits?: number;
  setTotpDigits?: (v: number) => void;
  totpPeriod?: number;
  setTotpPeriod?: (v: number) => void;
}

interface DecodedQr {
  secret: string;
  issuer: string | null;
  label: string | null;
  algorithm: string;
  digits: number;
  period: number;
}

function useTotpPreview(secret: string | undefined, algorithm: string | undefined, digits: number | undefined, period: number | undefined) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!secret) {
      setPreview(null);
      return;
    }
    const update = () => {
      try {
        setPreview(generateTotpCode({ secret, algorithm: algorithm ?? "SHA1", digits: digits ?? 6, period: period ?? 30 }).code);
      } catch {
        // An incomplete or invalid secret while typing has no code to show.
        setPreview(null);
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [secret, algorithm, digits, period]);
  return preview;
}

/** The One-Time Password (TOTP) box of the Credentials tab. */
export default function TotpSection(props: TotpSectionProps) {
  const { totpSecret, totpIssuer, totpLabel, totpAlgorithm, totpDigits, totpPeriod } = props;
  const [showManual, setShowManual] = useState(false);
  const preview = useTotpPreview(totpSecret, totpAlgorithm, totpDigits, totpPeriod);

  const handleImportQr = async () => {
    try {
      const filePath = await invoke<string | null>("totp_pick_qr_image");
      if (!filePath) return;
      const result = await invoke<DecodedQr>("totp_decode_qr", { filePath });
      props.setTotpSecret?.(result.secret);
      props.setTotpIssuer?.(result.issuer ?? "");
      props.setTotpLabel?.(result.label ?? "");
      props.setTotpAlgorithm?.(result.algorithm);
      props.setTotpDigits?.(result.digits);
      props.setTotpPeriod?.(result.period);
      setShowManual(false);
      toast.success("QR code imported successfully");
    } catch (err) {
      toast.error(errorText(err, "Failed to decode QR code"));
    }
  };

  const handleRemove = () => {
    props.setTotpSecret?.("");
    props.setTotpIssuer?.("");
    props.setTotpLabel?.("");
    props.setTotpAlgorithm?.("SHA1");
    props.setTotpDigits?.(6);
    props.setTotpPeriod?.(30);
    setShowManual(false);
  };

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <ShieldLockIcon size={16} className="text-ink-muted" />
          <p className="text-meta font-semibold text-ink-muted">One-Time Password (TOTP)</p>
        </div>
        {totpSecret && (
          <button
            type="button"
            onClick={handleRemove}
            className="flex h-control-sm items-center gap-1 rounded px-1.5 text-meta text-danger hover:bg-hover"
          >
            <TrashIcon size={12} />
            Remove
          </button>
        )}
      </div>

      {!totpSecret ? (
        <>
          <div className="flex gap-2">
            <Button icon="qrcode" onClick={handleImportQr} className="flex-1">
              Import QR Code
            </Button>
            <Button icon="keyboard" onClick={() => setShowManual(!showManual)} className="flex-1">
              Enter Secret Key
            </Button>
          </div>
          {showManual && (
            <div className="space-y-2">
              <Field label="Secret Key (Base32)">
                <TextInput
                  value={totpSecret ?? ""}
                  onChange={(e) => props.setTotpSecret?.(e.target.value.toUpperCase().replace(/\s/g, ""))}
                  className="font-mono"
                />
              </Field>
              <div className="flex gap-2">
                <Field label="Issuer" className="flex-1">
                  <TextInput value={totpIssuer ?? ""} onChange={(e) => props.setTotpIssuer?.(e.target.value)} />
                </Field>
                <Field label="Account" className="flex-1">
                  <TextInput value={totpLabel ?? ""} onChange={(e) => props.setTotpLabel?.(e.target.value)} />
                </Field>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {totpIssuer && (
            <div className="text-meta text-ink-secondary">
              <span className="text-ink-muted">Issuer:</span> {totpIssuer}
              {totpLabel && <> &middot; <span className="text-ink-muted">Account:</span> {totpLabel}</>}
            </div>
          )}
          <div className="text-meta text-ink-muted">
            {totpAlgorithm ?? "SHA1"} &middot; {totpDigits ?? 6} digits &middot; {totpPeriod ?? 30}s period
          </div>
          {preview && (
            <div className="flex items-center gap-2">
              <span className="font-mono text-title text-link">
                {preview.slice(0, Math.ceil(preview.length / 2))} {preview.slice(Math.ceil(preview.length / 2))}
              </span>
              <span className="text-meta text-success">Preview</span>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
