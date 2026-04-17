/**
 * TOTP code generator for the renderer process.
 *
 * Uses the `otpauth` package (browser-compatible, Web Crypto API).
 * Generates time-based one-time passwords with real-time countdown.
 */

import { TOTP } from "otpauth";

export interface TotpResult {
  code: string;
  remainingSeconds: number;
  period: number;
}

/**
 * Generate a TOTP code from the given parameters.
 *
 * @param secret - Base32-encoded TOTP secret
 * @param algorithm - Hash algorithm (SHA1, SHA256, SHA512). Default: SHA1
 * @param digits - Number of digits (6 or 8). Default: 6
 * @param period - Time step in seconds. Default: 30
 * @returns The current TOTP code and remaining seconds until refresh
 */
export function generateTotpCode(params: {
  secret: string;
  algorithm?: string;
  digits?: number;
  period?: number;
}): TotpResult {
  const algorithm = params.algorithm ?? "SHA1";
  const digits = params.digits ?? 6;
  const period = params.period ?? 30;

  const totp = new TOTP({
    secret: params.secret,
    algorithm,
    digits,
    period,
  });

  const code = totp.generate();
  const now = Math.floor(Date.now() / 1000);
  const remainingSeconds = period - (now % period);

  return { code, remainingSeconds, period };
}
