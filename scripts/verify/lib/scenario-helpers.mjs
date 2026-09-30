// ctx-based building blocks for personal-vault scenarios: a vault path in the run's cloud folder,
// signed-in devices, opening a vault from the hub past sync waits, waits on a shared file read
// through a private copy, numbered entries, and fingerprints for "nothing changed" checks.

import fs from 'node:fs';
import path from 'node:path';
import { sharedEntries } from './sync-files.mjs';
import { WAITING_TITLE, unlockOutcome } from './sync-flows.mjs';

const CONVERGE_MS = 30_000;

export const scratchDir = (ctx) => path.join(ctx.run.runDir, 'scratch');

export const rowOf = (rows, id) => rows.find((r) => r.id === id) ?? null;

/** `<cloud>/<dirs...>/Vault.conduit`, its folder created. */
export function vaultAt(ctx, ...dirs) {
  const dir = path.join(ctx.cloudDir, ...dirs);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'Vault.conduit');
}

/** Waits until `file` (read through a private copy) satisfies `pred(rows)`; returns the rows. */
export function waitShared(ctx, file, pred, label, timeoutMs = CONVERGE_MS) {
  return ctx.waitFor(async () => {
    if (!fs.existsSync(file)) return null;
    const rows = sharedEntries(file, scratchDir(ctx));
    return pred(rows) ? rows : null;
  }, { timeoutMs, intervalMs: 500, label: `${path.relative(ctx.cloudDir, file)}: ${label}` });
}

/** A new `role` user and devices `names` launched and signed in as that user: {user, devices}. */
export async function signedInDevices(ctx, role, names) {
  const user = await ctx.createUser(role);
  ctx.step(`created ${role} user ${user.email}`);
  const devices = await Promise.all(names.map((n) => ctx.launchDevice(n)));
  const who = await Promise.all(devices.map((d) => ctx.flows.signIn(d, user)));
  ctx.checkEqual(who.map((w) => w.tier), names.map(() => role), `every device signed in on the ${role} plan`);
  return { user, devices };
}

/**
 * Opens `file` from the hub and requires an unlock; a stale-file wait is ridden out.
 * `promptAtUnlock`: a sync dialog title the running engine may raise over the unlocked vault
 * (left open). Returns {outcome: 'unlocked', dialogs?}.
 */
export async function openVaultHere(ctx, device, file, password, { promptAtUnlock = null } = {}) {
  let res = await ctx.flows.openVault(device, file, password);
  if (res.outcome === 'dialog' && res.dialogs.every((t) => t === WAITING_TITLE)) res = await unlockOutcome(device);
  if (res.outcome === 'dialog' && res.dialogs.every((t) => t === promptAtUnlock) && (await ctx.ui.invoke(device, 'vault_is_unlocked'))) {
    res = { outcome: 'unlocked', dialogs: res.dialogs };
  }
  ctx.checkEqual(res.outcome, 'unlocked', `${device.name} opens ${path.relative(ctx.cloudDir, file)} (${res.dialogs?.join(', ') ?? ''})`);
  return res;
}

/** Entries `<prefix> 01..n` (ssh, host `<net>.<i>`) created over IPC, then the renderer reloads. */
export async function addNumberedEntries(ctx, device, prefix, net, n, extra = {}) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const name = `${prefix} ${String(i).padStart(2, '0')}`;
    out.push(await ctx.ui.invoke(device, 'entry_create', { name, entry_type: 'ssh', host: `${net}.${i}`, port: 22, ...extra }));
  }
  await ctx.flows.refreshEntries(device);
  return out;
}

/** id -> [name, host, port, folder_id] of a device's entries. */
export async function entryFingerprint(ctx, device) {
  return Object.fromEntries((await ctx.flows.listEntries(device)).map((e) => [e.id, [e.name, e.host, e.port, e.folder_id ?? null]]));
}

/** id -> [name, host, port] of the entries in `file`. */
export function sharedFingerprint(ctx, file) {
  return Object.fromEntries(sharedEntries(file, scratchDir(ctx)).map((r) => [r.id, [r.name, r.host, r.port]]));
}
