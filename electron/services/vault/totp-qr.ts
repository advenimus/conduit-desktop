/**
 * QR code decoder for TOTP setup.
 *
 * Reads a QR code image file, decodes it, and parses the otpauth:// URI
 * to extract TOTP parameters (secret, issuer, label, algorithm, digits, period).
 */

import fs from 'node:fs';
import sharp from 'sharp';

export interface TotpQrResult {
  secret: string;
  issuer: string | null;
  label: string | null;
  algorithm: string;
  digits: number;
  period: number;
}

/**
 * Decode a QR code image and extract TOTP parameters from the otpauth:// URI.
 *
 * @param filePath - Path to the QR code image (PNG, JPG, GIF, BMP, WebP)
 * @returns Parsed TOTP parameters
 */
export async function decodeQrImage(filePath: string): Promise<TotpQrResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Convert image to raw RGBA pixels using sharp
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const imageData = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);

  // jsqr is a CJS/UMD module. Under ESM interop, the callable may be on .default
  // or .default.default depending on the bundler/runtime. Handle both.
  const jsQRModule = await import('jsqr') as Record<string, unknown>;
  const jsQRFn = (
    typeof jsQRModule.default === 'function'
      ? jsQRModule.default
      : typeof (jsQRModule.default as Record<string, unknown>)?.default === 'function'
        ? (jsQRModule.default as Record<string, unknown>).default
        : jsQRModule.default
  ) as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
  const qrResult = jsQRFn(imageData, info.width, info.height);

  if (!qrResult) {
    throw new Error('No QR code found in the image');
  }

  return parseOtpauthUri(qrResult.data);
}

/**
 * Parse an otpauth:// URI into TOTP parameters.
 *
 * Format: otpauth://totp/LABEL?secret=BASE32&issuer=ISSUER&algorithm=SHA1&digits=6&period=30
 */
function parseOtpauthUri(uri: string): TotpQrResult {
  const url = new URL(uri);

  if (url.protocol !== 'otpauth:') {
    throw new Error(`Invalid protocol: expected otpauth:, got ${url.protocol}`);
  }

  if (url.host !== 'totp') {
    throw new Error(`Invalid type: expected totp, got ${url.host}`);
  }

  const secret = url.searchParams.get('secret');
  if (!secret) {
    throw new Error('Missing secret parameter in otpauth URI');
  }

  // Label is the path (e.g., /Issuer:user@example.com or /user@example.com)
  const rawLabel = decodeURIComponent(url.pathname.replace(/^\//, ''));
  let issuer = url.searchParams.get('issuer');
  let label = rawLabel;

  // If label contains "Issuer:Account", split it
  if (rawLabel.includes(':')) {
    const [prefix, rest] = rawLabel.split(':', 2);
    if (!issuer) issuer = prefix;
    label = rest;
  }

  const algorithm = url.searchParams.get('algorithm')?.toUpperCase() ?? 'SHA1';
  const digits = parseInt(url.searchParams.get('digits') ?? '6', 10);
  const period = parseInt(url.searchParams.get('period') ?? '30', 10);

  return {
    secret: secret.toUpperCase(),
    issuer: issuer || null,
    label: label || null,
    algorithm,
    digits,
    period,
  };
}
