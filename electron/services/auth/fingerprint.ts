/**
 * Device fingerprint collection for abuse detection.
 *
 * Collects hardware signals and hashes them into two digests:
 * - primaryHash: machine ID + serial only (survives peripheral changes)
 * - fullHash: all signals (exact machine match)
 */

import crypto from 'node:crypto';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { app } from 'electron';

export interface DeviceFingerprint {
  fingerprint_hash: string;  // full hash of all signals
  primary_hash: string;      // hardware-only hash (machine ID + serial)
  platform: string;          // 'darwin' | 'win32' | 'linux'
  app_version: string;
}

interface HardwareSignals {
  machineId: string;
  serial: string;
  cpuModel: string;
  cpuCount: number;
  totalMemory: number;
  platform: string;
  arch: string;
}

function execSafe(command: string): string {
  try {
    return execSync(command, { timeout: 5000, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function collectDarwinSignals(): { machineId: string; serial: string } {
  const ioreg = execSafe('ioreg -d2 -c IOPlatformExpertDevice');

  let machineId = '';
  let serial = '';

  const uuidMatch = ioreg.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  if (uuidMatch) machineId = uuidMatch[1];

  const serialMatch = ioreg.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
  if (serialMatch) serial = serialMatch[1];

  return { machineId, serial };
}

function collectWindowsSignals(): { machineId: string; serial: string } {
  let machineId = '';
  let serial = '';

  const regOutput = execSafe('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid');
  const guidMatch = regOutput.match(/MachineGuid\s+REG_SZ\s+(.+)/);
  if (guidMatch) machineId = guidMatch[1].trim();

  const wmicOutput = execSafe('wmic bios get serialnumber');
  const lines = wmicOutput.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) serial = lines[1];

  return { machineId, serial };
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function collectFingerprint(): DeviceFingerprint {
  const platform = process.platform;
  const arch = process.arch;

  // Platform-specific hardware IDs
  let hwSignals: { machineId: string; serial: string };
  if (platform === 'darwin') {
    hwSignals = collectDarwinSignals();
  } else if (platform === 'win32') {
    hwSignals = collectWindowsSignals();
  } else {
    hwSignals = { machineId: '', serial: '' };
  }

  // Fallback if platform commands failed
  if (!hwSignals.machineId && !hwSignals.serial) {
    hwSignals.machineId = os.hostname();
  }

  const signals: HardwareSignals = {
    machineId: hwSignals.machineId,
    serial: hwSignals.serial,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    totalMemory: os.totalmem(),
    platform,
    arch,
  };

  // Primary hash: hardware IDs only (stable across software changes)
  const primaryHash = sha256(`${signals.machineId}:${signals.serial}`);

  // Full hash: all signals (exact machine match)
  const fullHash = sha256(
    `${signals.machineId}:${signals.serial}:${signals.cpuModel}:${signals.cpuCount}:${signals.totalMemory}:${signals.platform}:${signals.arch}`
  );

  return {
    fingerprint_hash: fullHash,
    primary_hash: primaryHash,
    platform,
    app_version: app.getVersion(),
  };
}
