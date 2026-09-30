/**
 * manifest.json of a user's cloud backups ({userId}/manifest.json): which vaults are backed up,
 * their names, last backup time and size. Read and written whole, with upsert.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const MANIFEST_FILENAME = 'manifest.json';

export interface ManifestEntry {
  name: string;
  lastSyncedAt: string | null;
  size: number;
}

/** Manifest tracking all backed-up vaults for a user. */
export interface CloudManifest {
  vaults: Record<string, ManifestEntry>;
}

/** The manifest, or null when it does not exist or cannot be parsed. */
export async function readCloudManifest(supabase: SupabaseClient, bucket: string, userId: string): Promise<CloudManifest | null> {
  const { data, error } = await supabase.storage.from(bucket).download(`${userId}/${MANIFEST_FILENAME}`);
  if (error || !data) return null;
  try {
    return JSON.parse(await data.text()) as CloudManifest;
  } catch {
    console.warn('[cloud-sync] Failed to parse manifest.json');
    return null;
  }
}

/** Sets (or with null removes) one vault's entry; returns the Storage error, or null. */
export async function writeManifestEntry(
  supabase: SupabaseClient,
  bucket: string,
  userId: string,
  vaultId: string,
  entry: ManifestEntry | null,
): Promise<unknown> {
  const current = await readCloudManifest(supabase, bucket, userId);
  if (current === null && entry === null) return null;
  const vaults = { ...(current?.vaults ?? {}) };
  if (entry === null) delete vaults[vaultId];
  else vaults[vaultId] = entry;
  const blob = Buffer.from(JSON.stringify({ vaults }, null, 2), 'utf-8');
  const { error } = await supabase.storage
    .from(bucket)
    .upload(`${userId}/${MANIFEST_FILENAME}`, blob, { upsert: true, contentType: 'application/octet-stream' });
  if (error) {
    console.warn(`[cloud-sync] Failed to ${entry === null ? 'update manifest after removal' : 'update manifest'}:`, error.message);
    return error;
  }
  if (entry !== null) console.log('[cloud-sync] Manifest updated for vault:', entry.name);
  return null;
}
