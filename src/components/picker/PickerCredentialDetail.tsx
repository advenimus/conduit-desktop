import { useState, useEffect, useCallback } from "react";
import type { CredentialDto } from "../../types/credential";
import { generateTotpCode, type TotpResult } from "../../lib/totp";
import { toast } from "../common/Toast";

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
    <div className="flex flex-col h-full">
      {/* Back header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-stroke-dim shrink-0">
        <button
          onClick={onBack}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-well text-ink-muted hover:text-ink transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <span className="text-sm font-medium text-ink truncate">{credential.name}</span>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {fields.map((f) => (
          <div key={f.field}>
            <div className="text-xs text-ink-muted mb-1">{f.label}</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                {f.totp ? (
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-mono font-semibold text-ink tracking-wider">
                      {formatTotpCode(f.value)}
                    </span>
                    {totp && (
                      <TotpCountdown remaining={totp.remainingSeconds} period={totp.period} />
                    )}
                  </div>
                ) : f.secret && !showPassword ? (
                  <span className="text-sm text-ink font-mono">{"•".repeat(12)}</span>
                ) : (
                  <span className="text-sm text-ink break-all font-mono">{f.value}</span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {f.secret && (
                  <button
                    onClick={() => setShowPassword(!showPassword)}
                    className="w-7 h-7 flex items-center justify-center rounded hover:bg-well text-ink-muted hover:text-ink transition-colors"
                    title={showPassword ? "Hide" : "Show"}
                  >
                    {showPassword ? (
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178zM15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    )}
                  </button>
                )}
                <button
                  onClick={() => copyToClipboard(f.value, f.field)}
                  className="w-7 h-7 flex items-center justify-center rounded hover:bg-well text-ink-muted hover:text-ink transition-colors"
                  title="Copy"
                >
                  {copiedField === f.field ? (
                    <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        ))}

        {fields.length === 0 && (
          <div className="flex items-center justify-center h-32 text-sm text-ink-muted">
            No fields to display
          </div>
        )}
      </div>
    </div>
  );
}

function TotpCountdown({ remaining, period }: { remaining: number; period: number }) {
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const progress = remaining / period;
  const offset = circumference * (1 - progress);
  const isLow = remaining <= 5;

  return (
    <div className="flex items-center gap-1 shrink-0">
      <svg width="24" height="24" viewBox="0 0 24 24" className="shrink-0">
        <circle
          cx="12" cy="12" r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-stroke-dim"
        />
        <circle
          cx="12" cy="12" r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={isLow ? "text-red-400" : "text-conduit-500"}
          transform="rotate(-90 12 12)"
          style={{ transition: "stroke-dashoffset 1s linear" }}
        />
      </svg>
      <span className={`text-xs tabular-nums ${isLow ? "text-red-400" : "text-ink-muted"}`}>
        {remaining}s
      </span>
    </div>
  );
}
