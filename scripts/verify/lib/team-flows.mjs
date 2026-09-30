// Team vault flows on a device (on top of team.mjs): the identity key recovered on a second device
// of the same user, opening and closing a team vault the way the vault hub and the sidebar's vault
// menu do, the team vault's local cache file, the team rows on the server, and the personal-sync
// lineage folders a device keeps (to prove a team vault never gets one).

import fs from 'node:fs';
import path from 'node:path';
import { waitForScreen } from './flows.mjs';
import { sqlJson } from './supabase.mjs';
import { syncRootOf } from './vault-files.mjs';
import { clickSelector, clickText, dispatchDocumentEvent, exists, invoke, waitFor } from './ui.mjs';

const OPEN_TIMEOUT_MS = 60_000;

/** identity_key_recover with the passphrase identity_key_generate returned on the first device. */
export async function recoverIdentityKey(device, passphrase) {
  if (typeof passphrase !== 'string' || passphrase === '') throw new Error('recoverIdentityKey needs the recovery passphrase');
  await invoke(device, 'identity_key_recover', { passphrase }, { timeoutMs: 60_000 });
  if (!(await invoke(device, 'identity_key_exists'))) throw new Error(`${device.name}: identity key still missing after recovery`);
}

/** vault_get_type: 'team' while a team vault is the active vault, else 'personal'. */
export function activeVaultType(device) {
  return invoke(device, 'vault_get_type');
}

/**
 * Opens team vault {id, name} as the hub and the vault menu do (they lock the personal vault first):
 * the 'conduit:team-vault-unlock' event, then the connecting overlay until the main screen.
 */
export async function openTeamVaultInUi(device, vault, { timeoutMs = OPEN_TIMEOUT_MS } = {}) {
  await dispatchDocumentEvent(device, 'conduit:team-vault-unlock', { id: vault.id, name: vault.name });
  await waitFor(async () => (await activeVaultType(device)) === 'team', { timeoutMs, label: `${device.name}: team vault ${vault.name} active` });
  await waitForScreen(device, 'main', { timeoutMs });
}

/** Opens the sidebar with the tab bar's toggle when it is collapsed (test windows start that way). */
export async function openSidebar(device) {
  if (await exists(device, 'button[title="Open sidebar (Ctrl+B)"]')) await clickSelector(device, 'button[title="Open sidebar (Ctrl+B)"]');
  await waitFor(() => exists(device, 'button[title="Close sidebar (Ctrl+B)"]'), { timeoutMs: 10_000, label: `${device.name}: sidebar open` });
}

/** The sidebar's vault menu (its button shows the vault name) > "Lock Current Vault", then the hub. */
export async function lockFromVaultMenu(device, vaultName) {
  await openSidebar(device);
  await clickText(device, vaultName, { selector: 'button[title]' });
  await clickText(device, 'Lock Current Vault', { exact: true, selector: 'button' });
  await waitForScreen(device, 'hub');
}

/** <dataDir>/team-vaults/<id>.conduit: the local cache of a team vault. */
export function teamVaultFile(device, teamVaultId) {
  return path.join(device.dataDir, 'team-vaults', `${teamVaultId}.conduit`);
}

/** Live vault_entries rows of a team vault on the server: [{id, name, host}]. */
export function serverTeamEntries(teamVaultId) {
  return sqlJson(
    "select id, name, host from public.vault_entries where vault_id = :'vid' and deleted_at is null order by name",
    { vid: teamVaultId },
  );
}

/** Lineage folders under the device's syncRoot (<syncRoot>/m-<hw>/<lineage>), sorted. */
export function lineageDirs(device) {
  const root = syncRootOf(device);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((n) => n.startsWith('m-'))
    .flatMap((m) => fs.readdirSync(path.join(root, m), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${m}/${e.name}`))
    .sort();
}
