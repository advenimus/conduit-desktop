/**
 * Biometric vault unlock service.
 *
 * Stores the master password encrypted behind a platform biometric gate:
 * - macOS: LAContext authentication (Touch ID / Apple Watch / passcode) + Keychain (`safeStorage`)
 * - Windows: Stub (Windows Hello support planned for a follow-up)
 *
 * NOTE: We do NOT use Electron's `systemPreferences.promptTouchID()` because it
 * uses `LAPolicyDeviceOwnerAuthenticationWithBiometrics` which only supports
 * Touch ID/Face ID hardware. Our Swift helper uses `LAPolicyDeviceOwnerAuthentication`
 * which also supports Apple Watch unlock and device passcode fallback.
 *
 * The encrypted password is persisted in `{dataDir}/biometric/{vaultKey}.bio.enc`
 * where vaultKey is a SHA-256 hash of the vault file path.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeStorage } from 'electron';
import { getDataDir } from '../env-config.js';

const execFileAsync = promisify(execFile);

// -- Public interface --

export interface BiometricService {
  /** Check if biometric/watch authentication is available and encryption is supported. */
  isAvailable(): Promise<boolean>;

  /** Check if a stored biometric credential exists for the given vault. */
  isEnabledForVault(vaultKey: string): boolean;

  /** Encrypt and store the master password behind the biometric gate. */
  storePassword(vaultKey: string, masterPassword: string): Promise<void>;

  /**
   * Prompt for biometric authentication and retrieve the stored password.
   * Rejects if the user cancels or biometric fails.
   */
  retrievePassword(vaultKey: string, reason: string): Promise<string>;

  /** Remove stored biometric data for a specific vault. */
  removePassword(vaultKey: string): void;

  /** Remove all stored biometric data (all vaults). */
  removeAll(): void;
}

// -- Helpers --

/** Derive a filesystem-safe key from a vault file path. */
export function vaultPathToKey(vaultPath: string): string {
  return crypto.createHash('sha256').update(vaultPath).digest('hex');
}

function getBiometricDir(): string {
  return path.join(getDataDir(), 'biometric');
}

function getEncFilePath(vaultKey: string): string {
  return path.join(getBiometricDir(), `${vaultKey}.bio.enc`);
}

function ensureBiometricDir(): void {
  const dir = getBiometricDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// -- macOS native auth helper --
//
// A compiled Swift binary that uses LAContext with deviceOwnerAuthentication
// (supports Touch ID, Apple Watch, AND device passcode — unlike Electron's
// promptTouchID which only supports biometric hardware).

const SWIFT_SOURCE = `
import Foundation
import LocalAuthentication

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "check"

if mode == "check" {
    let context = LAContext()
    var error: NSError?
    let canEvaluate = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    print(canEvaluate ? "available" : "unavailable")
    exit(0)
} else if mode == "auth" {
    let reason = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "authenticate"
    let context = LAContext()
    let semaphore = DispatchSemaphore(value: 0)
    var exitCode: Int32 = 1
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, authError in
        if success {
            print("success")
            exitCode = 0
        } else {
            let code = (authError as NSError?)?.code ?? -1
            // LAError.userCancel = -2, LAError.systemCancel = -4, LAError.appCancel = -9
            if code == -2 || code == -4 || code == -9 {
                print("cancelled")
            } else {
                print("error:\\(authError?.localizedDescription ?? "unknown")")
            }
        }
        semaphore.signal()
    }
    semaphore.wait()
    exit(exitCode)
} else {
    print("error:unknown mode")
    exit(1)
}
`;

function getAuthHelperPath(): string {
  return path.join(getDataDir(), 'conduit-auth');
}

let helperReady: Promise<string> | null = null;

/**
 * Ensure the compiled Swift auth helper binary exists.
 * Compiles on first call, caches the binary for subsequent calls.
 */
function ensureAuthHelper(): Promise<string> {
  if (helperReady) return helperReady;

  helperReady = (async () => {
    const binaryPath = getAuthHelperPath();

    // Check if already compiled
    if (fs.existsSync(binaryPath)) {
      return binaryPath;
    }

    // Write Swift source and compile
    ensureBiometricDir();
    const srcPath = path.join(getBiometricDir(), 'conduit-auth.swift');
    fs.writeFileSync(srcPath, SWIFT_SOURCE);

    try {
      await execFileAsync('swiftc', [
        '-O', srcPath,
        '-o', binaryPath,
        '-framework', 'LocalAuthentication',
        '-framework', 'Foundation',
      ], { timeout: 30_000 });

      // Clean up source after successful compile
      try { fs.unlinkSync(srcPath); } catch { /* ignore */ }

      return binaryPath;
    } catch (err) {
      // Clean up on failure
      helperReady = null;
      try { fs.unlinkSync(srcPath); } catch { /* ignore */ }
      throw new Error(`Failed to compile auth helper: ${err}`);
    }
  })();

  return helperReady;
}

/**
 * Run the native auth helper with the given arguments.
 */
async function runAuthHelper(...args: string[]): Promise<string> {
  const binaryPath = await ensureAuthHelper();
  const { stdout } = await execFileAsync(binaryPath, args, { timeout: 60_000 });
  return stdout.trim();
}

// -- macOS implementation --

class MacOSBiometricService implements BiometricService {
  async isAvailable(): Promise<boolean> {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      const result = await runAuthHelper('check');
      return result === 'available';
    } catch {
      return false;
    }
  }

  isEnabledForVault(vaultKey: string): boolean {
    try {
      return fs.existsSync(getEncFilePath(vaultKey));
    } catch {
      return false;
    }
  }

  async storePassword(vaultKey: string, masterPassword: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Encryption is not available on this system');
    }

    ensureBiometricDir();

    const encrypted = safeStorage.encryptString(masterPassword);
    fs.writeFileSync(getEncFilePath(vaultKey), encrypted);
  }

  async retrievePassword(vaultKey: string, reason: string): Promise<string> {
    const filePath = getEncFilePath(vaultKey);

    if (!fs.existsSync(filePath)) {
      throw new Error('No biometric credential stored for this vault');
    }

    // Prompt for Touch ID / Apple Watch / device passcode
    const result = await runAuthHelper('auth', reason);
    if (result === 'cancelled') {
      throw new Error('Authentication was cancelled');
    }
    if (result !== 'success') {
      throw new Error(result.startsWith('error:') ? result.slice(6) : 'Authentication failed');
    }

    // Auth succeeded — decrypt the stored password
    try {
      const encrypted = fs.readFileSync(filePath);
      return safeStorage.decryptString(encrypted);
    } catch {
      // Corrupted file — clean it up so the user isn't stuck
      this.removePassword(vaultKey);
      throw new Error('Stored biometric credential is corrupted. Please unlock with your password.');
    }
  }

  removePassword(vaultKey: string): void {
    const filePath = getEncFilePath(vaultKey);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best-effort cleanup
    }
  }

  removeAll(): void {
    const dir = getBiometricDir();
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.bio.enc'));
        for (const file of files) {
          fs.unlinkSync(path.join(dir, file));
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

// -- Stub implementation (Windows / Linux — biometric not yet supported) --

class StubBiometricService implements BiometricService {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  isEnabledForVault(_vaultKey: string): boolean {
    return false;
  }

  async storePassword(_vaultKey: string, _masterPassword: string): Promise<void> {
    throw new Error('Biometric unlock is not supported on this platform');
  }

  async retrievePassword(_vaultKey: string, _reason: string): Promise<string> {
    throw new Error('Biometric unlock is not supported on this platform');
  }

  removePassword(_vaultKey: string): void {
    // No-op
  }

  removeAll(): void {
    // No-op
  }
}

// -- Factory --

let instance: BiometricService | null = null;

/** Get the platform-appropriate biometric service singleton. */
export function getBiometricService(): BiometricService {
  if (!instance) {
    instance = process.platform === 'darwin'
      ? new MacOSBiometricService()
      : new StubBiometricService();
  }
  return instance;
}
