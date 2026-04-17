/**
 * RDM SafePassword decryption.
 *
 * Devolutions Remote Desktop Manager uses a per-type obfuscation scheme:
 *   - Algorithm: TripleDES-ECB with PKCS7 padding
 *   - Key: MD5 hash of an ASCII GUID string (16 bytes, extended to 24)
 *   - Each connection sub-type (Terminal, RDP, Web, GroupDetails, etc.)
 *     uses a different built-in GUID as the key material
 *
 * The GUIDs are compiled into the RDM application and are the same
 * for all copies. No user-supplied passphrase is needed.
 */

import * as crypto from 'node:crypto';

/**
 * Built-in per-type encryption keys from the RDM application.
 * Each value is the GUID string passed through MD5 → TripleDES key.
 */
export const RDM_KEYS = {
  terminal: '{D6037472-976A-4EAB-8135-DE779F4EDF29}',
  rdp: '{9E6D0FD3-AD2B-4fe1-BBAC-F520BF2F1AE1}',
  web: '{545727BB-9372-4f05-B560-CD97D49E1BF2}',
  group: '{DEC5891B-0E61-4995-81FE-8F9F1AF000BF}',
  credential: '{E21537F0-4A43-4542-B62C-60AB6CD27B70}',
  credentialApiKey: '{BE136E76-C36B-4499-A834-D2892526847B}',
  vnc: '{FBF6C5D3-9E59-49ff-A87A-D09300CA11D5}',
  secureNote: '{F97C5192-D36A-4fdd-8D95-7B8F153BC150}',
} as const;

export type RdmKeyType = keyof typeof RDM_KEYS;

/**
 * Decrypt an RDM SafePassword field using the built-in per-type key.
 *
 * @param safePasswordB64 - Base64-encoded ciphertext from the XML
 * @param keyType - Which connection sub-type key to use
 * @returns decrypted plaintext, or null if decryption fails
 */
export function decryptSafePassword(
  safePasswordB64: string,
  keyType: RdmKeyType,
): string | null {
  if (!safePasswordB64 || safePasswordB64.trim() === '') return null;

  let cipherBuf: Buffer;
  try {
    cipherBuf = Buffer.from(safePasswordB64, 'base64');
  } catch {
    return null;
  }

  if (cipherBuf.length === 0) return null;
  if (cipherBuf.length % 8 !== 0) return null;

  return deobfuscate(cipherBuf, RDM_KEYS[keyType]);
}

// ── Core decryption ─────────────────────────────────────────────────

/**
 * Replicate RDM's ObfuscationUtils.Deobfuscate():
 *   1. MD5(ASCII bytes of GUID string) → 16-byte hash
 *   2. Extend to 24 bytes: hash + hash[0..8]
 *   3. TripleDES-ECB decrypt with PKCS7 padding
 *   4. Return UTF-8 string
 */
function deobfuscate(data: Buffer, keyGuid: string): string | null {
  try {
    const md5 = crypto.createHash('md5')
      .update(Buffer.from(keyGuid, 'ascii'))
      .digest();
    const key24 = Buffer.concat([md5, md5.subarray(0, 8)]);

    // Electron uses BoringSSL which doesn't support des-ede3-ecb.
    // Simulate ECB by decrypting each 8-byte block independently
    // using CBC with a zero IV (CBC with zero IV on a single block = ECB).
    const blockSize = 8;
    const zeroIv = Buffer.alloc(blockSize);
    const blocks: Buffer[] = [];

    for (let i = 0; i < data.length; i += blockSize) {
      const block = data.subarray(i, i + blockSize);
      const decipher = crypto.createDecipheriv('des-ede3-cbc', key24, zeroIv);
      decipher.setAutoPadding(false);
      blocks.push(decipher.update(block));
      blocks.push(decipher.final());
    }

    const raw = Buffer.concat(blocks);

    // Remove PKCS7 padding
    const padLen = raw[raw.length - 1];
    if (padLen < 1 || padLen > blockSize) return null;
    for (let i = raw.length - padLen; i < raw.length; i++) {
      if (raw[i] !== padLen) return null; // invalid padding
    }

    return raw.subarray(0, raw.length - padLen).toString('utf-8');
  } catch {
    return null;
  }
}
