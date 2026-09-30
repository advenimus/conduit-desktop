import { useState, useEffect, useCallback } from "react";
import type { CredentialDto } from "../../types/credential";
import { generateTotpCode, type TotpResult } from "../../lib/totp";
import { toast } from "../common/Toast";
import { IconButton } from "../ui";
import TotpCountdown from "./TotpCountdown";

interface PickerCredentialDetailProps {
  credential: CredentialDto;
  onBack: () => void;
}

export default function PickerCredentialDetail({ credential, onBack }: PickerCredentialDetailProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [totp, setTotp] = useState<TotpResult | null>(null);

  // TOTP timer
  useEffect(() => {
    if (!credential.totp_secret) return;
    const update = () => {
      try {
        const result = generateTotpCode({
          secret: credential.totp_secret!,
          algorithm: credential.totp_algorithm ?? undefined,
          digits: credential.totp_digits ?? undefined,
          period: credential.totp_period ?? undefined,
        });
        setTotp(result);
      } catch {
        setTotp(null);
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [credential]);

  const copyToClipboard = useCallback(async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
      toast.success(`${field.charAt(0).toUpperCase() + field.slice(1).replace("_", " ")} copied`);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  }, []);

  const formatTotpCode = (code: string) => {
    const mid = Math.ceil(code.length / 2);
    return code.slice(0, mid) + " " + code.slice(mid);
  };

  const fields: Array<{ label: string; value: string; field: string; secret?: boolean; totp?: boolean }> = [];

  if (credential.username) {
    fields.push({ label: "Username", value: credential.username, field: "username" });
  }
  if (credential.password) {
    fields.push({ label: "Password", value: credential.password, field: "password", secret: true });
  }
  if (credential.totp_secret && totp) {
    fields.push({ label: "TOTP Code", value: totp.code, field: "totp", totp: true });
  }
  if (credential.domain) {
    fields.push({ label: "Domain", value: credential.domain, field: "domain" });
  }
  if (credential.private_key) {
    fields.push({ label: "Private Key", value: credential.private_key, field: "private_key", secret: true });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Back header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-divider px-3 py-2">
        <IconButton icon="chevronLeft" label="Back" onClick={onBack} />
        <span className="truncate text-body font-semibold text-ink">{credential.name}</span>
      </div>

      {/* Fields */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {fields.map((f) => (
          <div key={f.field}>
            <div className="mb-1 text-label text-ink-muted">{f.label}</div>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                {f.totp ? (
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-title font-semibold text-ink">{formatTotpCode(f.value)}</span>
                    {totp && <TotpCountdown remaining={totp.remainingSeconds} period={totp.period} />}
                  </div>
                ) : f.secret && !showPassword ? (
                  <span className="font-mono text-body text-ink">{"•".repeat(12)}</span>
                ) : (
                  <span className="break-all font-mono text-body text-ink">{f.value}</span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {f.secret && (
                  <IconButton
                    icon={showPassword ? "eyeOff" : "eye"}
                    label={showPassword ? "Hide" : "Show"}
                    onClick={() => setShowPassword(!showPassword)}
                  />
                )}
                <IconButton
                  icon={copiedField === f.field ? "check" : "copy"}
                  label="Copy"
                  tone={copiedField === f.field ? "inherit" : "default"}
                  className={copiedField === f.field ? "text-success" : undefined}
                  onClick={() => copyToClipboard(f.value, f.field)}
                />
              </div>
            </div>
          </div>
        ))}

        {fields.length === 0 && (
          <div className="flex h-32 items-center justify-center text-body text-ink-muted">
            No fields to display
          </div>
        )}
      </div>
    </div>
  );
}
