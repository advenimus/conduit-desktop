/**
 * Shared SSH auth resolution logic.
 *
 * Three-layer resolution: per-entry/credential preference → global default → 'key' (hardcoded).
 */

import type { SshAuth } from './client.js';
import { readSettings } from '../../ipc/settings.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

interface CredentialData {
  username: string | null;
  password: string | null;
  private_key: string | null;
  ssh_auth_method?: string | null;
}

/**
 * Resolve the SSH auth method to use for a credential that may have both key and password.
 *
 * @param cred       The credential data (username, password, private_key, ssh_auth_method)
 * @param overrideMethod  Optional per-entry override (from SSH entry config)
 */
export function resolveSshAuth(cred: CredentialData, overrideMethod?: string | null): SshAuth {
  const hasKey = !!cred.private_key;
  const hasPassword = !!cred.password;
  // Default to current OS username (matches OpenSSH behavior)
  const username = cred.username || os.userInfo().username;

  if (hasKey && hasPassword) {
    // Determine preferred method: per-entry override → credential preference → global default → 'key'
    const settings = readSettings();
    const globalDefault = settings.session_defaults_ssh?.authMethodWhenKeyPresent ?? 'key';
    const method = overrideMethod ?? cred.ssh_auth_method ?? globalDefault;

    if (method === 'password') {
      return { type: 'password', username, password: cred.password! };
    }
    return { type: 'public_key', username, keyContent: cred.private_key! };
  }

  if (hasKey) {
    return { type: 'public_key', username, keyContent: cred.private_key! };
  }

  if (hasPassword) {
    return { type: 'password', username, password: cred.password! };
  }

  return { type: 'password', username, password: '' };
}

/**
 * Resolve SSH auth from system defaults (current user + default SSH key).
 */
export function resolveSshAuthSystem(): SshAuth {
  const currentUser = os.userInfo().username;
  const ed25519KeyPath = path.join(os.homedir(), '.ssh', 'id_ed25519');
  const rsaKeyPath = path.join(os.homedir(), '.ssh', 'id_rsa');

  const keyPath = fs.existsSync(ed25519KeyPath) ? ed25519KeyPath
    : fs.existsSync(rsaKeyPath) ? rsaKeyPath
    : null;

  if (keyPath) {
    return { type: 'public_key', username: currentUser, keyPath };
  }
  return { type: 'password', username: currentUser, password: '' };
}
