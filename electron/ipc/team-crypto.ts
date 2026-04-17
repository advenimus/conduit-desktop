/**
 * IPC handlers for identity key management and device authorization.
 *
 * Manages the X25519 identity key pair lifecycle:
 * - Generation, local storage (safeStorage), and Supabase public key upload
 * - Recovery passphrase backup and restore
 * - Device authorization (key transfer between devices)
 */

import { ipcMain } from 'electron';
import os from 'node:os';
import { AppState } from '../services/state.js';
import {
  generateIdentityKeyPair,
  storePrivateKey,
  loadPrivateKey,
  hasPrivateKey,
  derivePublicKey,
  generateRecoveryPassphrase,
  encryptPrivateKeyForRecovery,
  decryptPrivateKeyFromRecovery,
  getOrCreateDeviceId,
  wrapVEK,
  unwrapVEK,
} from '../services/vault/team-crypto.js';

/** Temp private keys for device auth, keyed by requestId. Never exposed to renderer. */
const pendingDeviceAuthKeys = new Map<string, { key: string; timer: ReturnType<typeof setTimeout> }>();

/** How long to keep a pending key before auto-cleanup (10 minutes). */
const DEVICE_AUTH_KEY_TTL_MS = 10 * 60 * 1000;

function storeTempKey(requestId: string, tempPrivateKeyB64: string): void {
  // Clear any existing entry for this requestId
  clearTempKey(requestId);

  const timer = setTimeout(() => {
    pendingDeviceAuthKeys.delete(requestId);
  }, DEVICE_AUTH_KEY_TTL_MS);

  // Unref so it doesn't keep the process alive
  if (timer.unref) timer.unref();

  pendingDeviceAuthKeys.set(requestId, { key: tempPrivateKeyB64, timer });
}

function retrieveAndClearTempKey(requestId: string): string {
  const entry = pendingDeviceAuthKeys.get(requestId);
  if (!entry) {
    throw new Error('Device auth session not found or expired');
  }
  clearTimeout(entry.timer);
  pendingDeviceAuthKeys.delete(requestId);
  return entry.key;
}

function clearTempKey(requestId: string): void {
  const entry = pendingDeviceAuthKeys.get(requestId);
  if (entry) {
    clearTimeout(entry.timer);
    pendingDeviceAuthKeys.delete(requestId);
  }
}

export function registerTeamCryptoHandlers(): void {
  const state = AppState.getInstance();

  /**
   * Generate a new identity key pair, store locally, upload public key,
   * and create a recovery backup in Supabase.
   *
   * Returns the recovery passphrase for the user to write down.
   */
  ipcMain.handle('identity_key_generate', async () => {
    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) {
      throw new Error('Not authenticated');
    }

    const supabase = state.authService.getSupabaseClient();
    const userId = authState.user.id;
    const deviceId = getOrCreateDeviceId(userId);
    const deviceName = os.hostname();

    // Generate key pair
    const { privateDer, publicDer } = generateIdentityKeyPair();

    // Store private key locally (encrypted with OS keychain)
    storePrivateKey(privateDer, userId);

    // Upload public key to Supabase
    const { error: pubKeyError } = await supabase
      .from('user_public_keys')
      .upsert({
        user_id: userId,
        device_id: deviceId,
        device_name: deviceName,
        public_key_b64: publicDer.toString('base64'),
        key_type: 'x25519',
        is_active: true,
      }, {
        onConflict: 'user_id,device_id',
      });

    if (pubKeyError) {
      throw new Error(`Failed to upload public key: ${pubKeyError.message}`);
    }

    // Generate recovery passphrase and encrypt private key for backup
    const passphrase = generateRecoveryPassphrase();
    const { encryptedB64, saltB64 } = encryptPrivateKeyForRecovery(privateDer, passphrase);

    // Store recovery backup in Supabase
    const { error: backupError } = await supabase
      .from('user_key_backups')
      .upsert({
        user_id: userId,
        encrypted_private_key_b64: encryptedB64,
        kdf_salt_b64: saltB64,
        kdf_algorithm: 'pbkdf2-sha256-600k',
      }, {
        onConflict: 'user_id',
      });

    if (backupError) {
      throw new Error(`Failed to store recovery backup: ${backupError.message}`);
    }

    // Zero private key memory
    privateDer.fill(0);

    return {
      recoveryPassphrase: passphrase,
      deviceId,
      publicKeyB64: publicDer.toString('base64'),
    };
  });

  /**
   * Check if a local identity private key exists on this device.
   */
  ipcMain.handle('identity_key_exists', async () => {
    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) return false;
    return hasPrivateKey(authState.user.id);
  });

  /**
   * Check if the user has a recovery backup in Supabase.
   * Returns true if they've previously generated an identity key (on any device).
   * Used to distinguish first-time setup (generate key) from returning user (recover key).
   */
  ipcMain.handle('identity_key_has_backup', async () => {
    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) {
      return false;
    }

    const supabase = state.authService.getSupabaseClient();
    const { count, error } = await supabase
      .from('user_key_backups')
      .select('user_id', { count: 'exact', head: true })
      .eq('user_id', authState.user.id);

    if (error) {
      console.warn('[team-crypto] Failed to check key backup:', error.message);
      return false;
    }

    return (count ?? 0) > 0;
  });

  /**
   * Get the local identity public key (derived from stored private key).
   */
  ipcMain.handle('identity_key_get_public', async () => {
    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) return null;
    const privateDer = loadPrivateKey(authState.user.id);
    if (!privateDer) return null;

    const publicDer = derivePublicKey(privateDer);
    return publicDer.toString('base64');
  });

  /**
   * Recover identity key from recovery passphrase.
   * Downloads the encrypted backup from Supabase, decrypts it,
   * stores the private key locally, and registers this device's public key.
   */
  ipcMain.handle('identity_key_recover', async (_e, args) => {
    const { passphrase } = args as { passphrase: string };

    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) {
      throw new Error('Not authenticated');
    }

    const supabase = state.authService.getSupabaseClient();
    const userId = authState.user.id;
    const deviceId = getOrCreateDeviceId(userId);
    const deviceName = os.hostname();

    // Fetch recovery backup
    const { data: backup, error: fetchError } = await supabase
      .from('user_key_backups')
      .select('encrypted_private_key_b64, kdf_salt_b64')
      .eq('user_id', userId)
      .single();

    if (fetchError || !backup) {
      throw new Error('No recovery backup found. Generate a new identity key instead.');
    }

    // Decrypt private key with passphrase
    let privateDer: Buffer;
    try {
      privateDer = decryptPrivateKeyFromRecovery(
        backup.encrypted_private_key_b64,
        backup.kdf_salt_b64,
        passphrase,
      );
    } catch {
      throw new Error('Invalid recovery passphrase');
    }

    // Store private key locally (user-scoped)
    storePrivateKey(privateDer, userId);

    // Register this device's public key
    const publicDer = derivePublicKey(privateDer);
    const { error: pubKeyError } = await supabase
      .from('user_public_keys')
      .upsert({
        user_id: userId,
        device_id: deviceId,
        device_name: deviceName,
        public_key_b64: publicDer.toString('base64'),
        key_type: 'x25519',
        is_active: true,
      }, {
        onConflict: 'user_id,device_id',
      });

    if (pubKeyError) {
      throw new Error(`Failed to register device: ${pubKeyError.message}`);
    }

    privateDer.fill(0);
    return { deviceId, publicKeyB64: publicDer.toString('base64') };
  });

  /**
   * Create a device authorization request (new device requesting key transfer).
   * The new device generates a temporary key pair and waits for approval.
   */
  ipcMain.handle('device_auth_request', async () => {
    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) {
      throw new Error('Not authenticated');
    }

    const supabase = state.authService.getSupabaseClient();
    const userId = authState.user.id;
    const deviceId = getOrCreateDeviceId(userId);
    const deviceName = os.hostname();

    // Generate temporary key pair for this request
    const { privateDer, publicDer } = generateIdentityKeyPair();

    const tempPrivateKeyB64 = privateDer.toString('base64');
    privateDer.fill(0);

    const { data: request, error } = await supabase
      .from('device_auth_requests')
      .insert({
        user_id: userId,
        requesting_device_id: deviceId,
        requesting_device_name: deviceName,
        requesting_public_key_b64: publicDer.toString('base64'),
        status: 'pending',
      })
      .select('id')
      .single();

    if (error || !request) {
      throw new Error(`Failed to create auth request: ${error?.message}`);
    }

    // Store temp private key in main process only — never sent to renderer
    storeTempKey(request.id, tempPrivateKeyB64);

    return {
      requestId: request.id,
    };
  });

  /**
   * Approve a device authorization request (existing device approving new device).
   * Wraps the identity private key for the requesting device's temporary public key.
   */
  ipcMain.handle('device_auth_approve', async (_e, args) => {
    const { requestId } = args as { requestId: string };

    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) {
      throw new Error('Not authenticated');
    }

    const supabase = state.authService.getSupabaseClient();

    // Load our private key
    const privateDer = loadPrivateKey(authState.user.id);
    if (!privateDer) {
      throw new Error('No local identity key found');
    }

    try {
      // Fetch the request to get the requesting device's public key
      const { data: request, error: fetchError } = await supabase
        .from('device_auth_requests')
        .select('*')
        .eq('id', requestId)
        .eq('user_id', authState.user.id)
        .eq('status', 'pending')
        .single();

      if (fetchError || !request) {
        throw new Error('Authorization request not found or already processed');
      }

      // Wrap our private key for the requesting device
      const requestingPubDer = Buffer.from(request.requesting_public_key_b64, 'base64');
      const wrapped = wrapVEK(privateDer, requestingPubDer);

      // Update the request with the wrapped key
      const { error: updateError } = await supabase
        .from('device_auth_requests')
        .update({
          status: 'approved',
          encrypted_private_key_b64: wrapped.encryptedVekB64,
          ephemeral_public_key_b64: wrapped.ephemeralPublicKeyB64,
        })
        .eq('id', requestId);

      if (updateError) {
        throw new Error(`Failed to approve request: ${updateError.message}`);
      }

      return { success: true };
    } finally {
      privateDer.fill(0);
    }
  });

  /**
   * Check if a device authorization request has been approved.
   * If approved, unwrap the private key and store it locally.
   */
  ipcMain.handle('device_auth_check', async (_e, args) => {
    const { requestId } = args as { requestId: string };

    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) {
      throw new Error('Not authenticated');
    }

    const supabase = state.authService.getSupabaseClient();

    const { data: request, error } = await supabase
      .from('device_auth_requests')
      .select('*')
      .eq('id', requestId)
      .eq('user_id', authState.user.id)
      .single();

    if (error || !request) {
      throw new Error('Authorization request not found');
    }

    if (request.status === 'pending') {
      return { status: 'pending' as const };
    }

    if (request.status === 'denied') {
      clearTempKey(requestId);
      return { status: 'denied' as const };
    }

    if (request.status === 'expired') {
      clearTempKey(requestId);
      return { status: 'expired' as const };
    }

    if (request.status === 'approved') {
      if (!request.encrypted_private_key_b64 || !request.ephemeral_public_key_b64) {
        throw new Error('Approved request missing key data');
      }

      // Retrieve temp private key from main-process store
      const tempPrivateKeyB64 = retrieveAndClearTempKey(requestId);

      // Unwrap the private key
      const tempPrivateDer = Buffer.from(tempPrivateKeyB64, 'base64');
      const tempPublicDer = derivePublicKey(tempPrivateDer);

      const identityPrivateDer = unwrapVEK(
        {
          ephemeralPublicKeyB64: request.ephemeral_public_key_b64,
          encryptedVekB64: request.encrypted_private_key_b64,
        },
        tempPrivateDer,
        tempPublicDer,
      );

      // Store the identity private key locally (user-scoped)
      storePrivateKey(identityPrivateDer, authState.user.id);

      // Register this device's public key
      const deviceId = getOrCreateDeviceId(authState.user.id);
      const deviceName = os.hostname();
      const publicDer = derivePublicKey(identityPrivateDer);

      await supabase
        .from('user_public_keys')
        .upsert({
          user_id: authState.user.id,
          device_id: deviceId,
          device_name: deviceName,
          public_key_b64: publicDer.toString('base64'),
          key_type: 'x25519',
          is_active: true,
        }, {
          onConflict: 'user_id,device_id',
        });

      tempPrivateDer.fill(0);
      identityPrivateDer.fill(0);

      return { status: 'approved' as const };
    }

    return { status: request.status as string };
  });

  /**
   * List pending device authorization requests targeting this user
   * (from other devices, not from this device).
   */
  ipcMain.handle('device_auth_list_pending', async () => {
    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) return [];

    // Only list requests if we have a key (can actually approve)
    if (!hasPrivateKey(authState.user.id)) return [];

    const supabase = state.authService.getSupabaseClient();
    const deviceId = getOrCreateDeviceId(authState.user.id);

    const { data } = await supabase
      .from('device_auth_requests')
      .select('id, requesting_device_name, created_at')
      .eq('user_id', authState.user.id)
      .eq('status', 'pending')
      .neq('requesting_device_id', deviceId)
      .gt('expires_at', new Date().toISOString());

    return data ?? [];
  });

  /**
   * Deny a device authorization request.
   */
  ipcMain.handle('device_auth_deny', async (_e, args) => {
    const { requestId } = args as { requestId: string };

    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) {
      throw new Error('Not authenticated');
    }

    const supabase = state.authService.getSupabaseClient();

    const { error } = await supabase
      .from('device_auth_requests')
      .update({ status: 'denied' })
      .eq('id', requestId)
      .eq('user_id', authState.user.id)
      .eq('status', 'pending');

    if (error) {
      throw new Error(`Failed to deny request: ${error.message}`);
    }

    return { success: true };
  });

  /**
   * Get the current device ID.
   */
  ipcMain.handle('identity_get_device_id', async () => {
    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) {
      throw new Error('Not authenticated');
    }
    return getOrCreateDeviceId(authState.user.id);
  });
}
