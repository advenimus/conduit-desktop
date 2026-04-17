/**
 * IPC handler for SSH key pair generation.
 *
 * Uses ssh2's generateKeyPairSync() to produce OpenSSH-formatted keys
 * that are directly compatible with the ssh2 client library.
 */

import crypto from 'node:crypto';
import { ipcMain } from 'electron';
import ssh2 from 'ssh2';

interface SshKeyGenArgs {
  type: 'ed25519' | 'rsa' | 'ecdsa';
  bits?: number;
  curve?: 'P-256' | 'P-384' | 'P-521';
  passphrase?: string;
  comment?: string;
}

interface SshKeyGenResult {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}

/** Map ECDSA curve name to ssh2 bits parameter. */
function ecdsaCurveToBits(curve: string): number {
  switch (curve) {
    case 'P-256': return 256;
    case 'P-384': return 384;
    case 'P-521': return 521;
    default: return 256;
  }
}

/** Compute SHA-256 fingerprint from an OpenSSH public key line. */
function computeFingerprint(publicKey: string): string {
  // OpenSSH format: "type base64data [comment]"
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2) return '';
  const keyData = Buffer.from(parts[1], 'base64');
  const hash = crypto.createHash('sha256').update(keyData).digest('base64');
  // Remove trailing '=' padding to match ssh-keygen output
  return `SHA256:${hash.replace(/=+$/, '')}`;
}

export function registerSshKeygenHandlers(): void {
  ipcMain.handle('ssh_generate_keypair', async (_e, args: SshKeyGenArgs): Promise<SshKeyGenResult> => {
    const { type, bits, curve, passphrase, comment } = args;

    // Build ssh2 keygen options
    const opts: Record<string, unknown> = {};
    if (comment) opts.comment = comment;
    if (passphrase) {
      opts.passphrase = passphrase;
      opts.cipher = 'aes256-ctr';
    }

    switch (type) {
      case 'ed25519':
        break; // No extra options needed
      case 'rsa':
        opts.bits = bits === 2048 ? 2048 : 4096;
        break;
      case 'ecdsa':
        opts.bits = ecdsaCurveToBits(curve ?? 'P-256');
        break;
      default:
        throw new Error(`Unsupported key type: ${type}`);
    }

    // ssh2's generateKeyPairSync returns { private: string, public: string }
    // in OpenSSH format (-----BEGIN OPENSSH PRIVATE KEY-----)
    const result = ssh2.utils.generateKeyPairSync(type, opts);

    const fingerprint = computeFingerprint(result.public);

    return {
      privateKey: result.private,
      publicKey: result.public,
      fingerprint,
    };
  });
}
