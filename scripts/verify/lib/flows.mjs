// App flows built on ui.mjs: screens, sign-in, local mode, vault create/open/unlock/lock, entries,
// and the conflict review panel. They drive the real UI where the user would, and IPC where the
// renderer itself only calls IPC.

import fs from 'node:fs';
import { passwordSession } from './supabase.mjs';
import {
  bodyText,
  clickSelector,
  clickText,
  dispatchDocumentEvent,
  exists,
  invoke,
  mainEval,
  stubFileDialogs,
  typeInto,
  waitFor,
  waitForText,
  withTimeout,
} from './ui.mjs';

const HUB_TEXT = 'Select a vault to get started';
const AUTH_TEXT = 'Continue without signing in';
const PASSWORD_INPUT = 'input[placeholder="Enter master password"]';
const CONFIRM_INPUT = 'input[placeholder="Confirm master password"]';
const SUBMIT = '[data-dialog-content] form button[type=submit]';
const UNLOCK_TIMEOUT_MS = 60_000;

/** 'loading' | 'auth' | 'hub' | 'main'. The hub may have a dialog on top of it. */
export async function currentScreen(device) {
  const text = await bodyText(device, { timeoutMs: 10_000 });
  if (text.includes(AUTH_TEXT)) return 'auth';
  if (text.includes(HUB_TEXT)) return 'hub';
  if (text.trim() === '' || text.trim() === 'Loading...') return 'loading';
  return 'main';
}

export function waitForScreen(device, screen, { timeoutMs = 60_000 } = {}) {
  return waitFor(async () => (await currentScreen(device)) === screen, { timeoutMs, label: `${device.name}: ${screen} screen` });
}

/** Titles of the open sync dialogs (role=dialog with an aria-label). */
export function openDialogs(device) {
  const titles = device.page.evaluate(() =>
    [...document.querySelectorAll('[role=dialog]')].filter((el) => el.getClientRects().length > 0).map((el) => el.getAttribute('aria-label') ?? ''),
  );
  return withTimeout(titles, 10_000, `${device.name}: read dialogs`);
}

/** "Continue without signing in" on the sign-in screen, then the vault hub. */
export async function enterLocalMode(device) {
  await waitForScreen(device, 'auth');
  await clickText(device, AUTH_TEXT, { exact: true, selector: 'button' });
  await waitForScreen(device, 'hub');
}

/**
 * Signs `user` in the way the website does: a password grant against local Supabase, then the
 * conduit://auth/callback deep link handed to the app's open-url handler. Resolves on the vault hub.
 */
export async function signIn(device, user) {
  const { accessToken, refreshToken } = await passwordSession(user);
  const url = `conduit://auth/callback#access_token=${accessToken}&refresh_token=${refreshToken}&token_type=bearer`;
  await mainEval(device, ({ app }, link) => {
    app.emit('open-url', { preventDefault() {} }, link);
  }, url, { label: 'deliver auth deep link' });
  const state = await waitFor(async () => {
    const s = await invoke(device, 'auth_get_state', undefined, { timeoutMs: 10_000 });
    return s?.isAuthenticated && s.profile ? s : null;
  }, { timeoutMs: 30_000, label: `${device.name}: signed in as ${user.email}` });
  await waitForScreen(device, 'hub');
  return { email: state.user?.email ?? null, tier: state.profile?.tier?.name ?? null };
}

export async function signOut(device) {
  await invoke(device, 'auth_sign_out');
}

async function dismissBiometricOffer(device, text) {
  if (text.includes('Not Now')) await clickText(device, 'Not Now', { exact: true, selector: 'button', timeoutMs: 5_000 });
}

/**
 * Waits for the unlock attempt to settle: {outcome: 'unlocked'}, {outcome: 'dialog', dialogs, text}
 * for a sync dialog (take-over, password changed, damaged copy), or {outcome: 'error', text}.
 */
export function waitForUnlockOutcome(device, { timeoutMs = UNLOCK_TIMEOUT_MS } = {}) {
  return waitFor(async () => {
    const text = await bodyText(device, { timeoutMs: 10_000 });
    await dismissBiometricOffer(device, text);
    if (await invoke(device, 'vault_is_unlocked', undefined, { timeoutMs: 10_000 }) && !text.includes(HUB_TEXT)) {
      return { outcome: 'unlocked' };
    }
    const dialogs = await openDialogs(device);
    // `text` was read before the dialog check and can predate the dialog: read it again.
    if (dialogs.length > 0) return { outcome: 'dialog', dialogs, text: await bodyText(device, { timeoutMs: 10_000 }) };
    if (!text.includes('Please wait...') && (await exists(device, '[data-dialog-content] .text-red-400'))) {
      return { outcome: 'error', text };
    }
    return null;
  }, { timeoutMs, label: `${device.name}: unlock outcome` });
}

async function expectUnlocked(device, action) {
  const res = await waitForUnlockOutcome(device);
  if (res.outcome !== 'unlocked') {
    throw new Error(`${device.name}: ${action} did not unlock (${res.outcome}${res.dialogs ? `: ${res.dialogs.join(', ')}` : ''})\n${res.text.slice(0, 600)}`);
  }
  return res;
}

/** Hub "New Vault" with the save dialog answered `filePath`, then the create form. */
export async function createVault(device, filePath, password) {
  if (fs.existsSync(filePath)) {
    throw new Error(`createVault: ${filePath} already exists, so the hub would open it instead; another scenario or suite used this folder`);
  }
  await waitForScreen(device, 'hub');
  await stubFileDialogs(device, filePath);
  await clickText(device, 'New Vault', { exact: true, selector: 'button' });
  await waitForText(device, 'Set a master password');
  await typeInto(device, PASSWORD_INPUT, password);
  await typeInto(device, CONFIRM_INPUT, password);
  await clickSelector(device, SUBMIT);
  return expectUnlocked(device, `create ${filePath}`);
}

/**
 * Hub "Open Vault File" with the open dialog answered `filePath`, then the unlock form.
 * Returns the outcome (see waitForUnlockOutcome) instead of throwing, so sync scenarios can
 * assert on take-over and error dialogs. Pass {expect: 'unlocked'} to throw on anything else.
 */
export async function openVault(device, filePath, password, { expect } = {}) {
  await waitForScreen(device, 'hub');
  await stubFileDialogs(device, filePath);
  await clickText(device, 'Open Vault File', { exact: true, selector: 'button' });
  await waitForText(device, 'Unlock Vault');
  await typeInto(device, PASSWORD_INPUT, password);
  await clickSelector(device, SUBMIT);
  if (expect === 'unlocked') return expectUnlocked(device, `open ${filePath}`);
  return waitForUnlockOutcome(device);
}

/** Locks through the renderer (same path as the menu), then waits for the hub. */
export async function lockVault(device) {
  await dispatchDocumentEvent(device, 'conduit:lock-vault');
  await waitForScreen(device, 'hub');
}

/** Tells the renderer to reload entries, as the app does after MCP writes. */
export function refreshEntries(device) {
  return mainEval(device, ({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('vault:entry-changed');
  }, undefined, { label: 'refresh entries' });
}

export async function addEntry(device, fields = {}) {
  const entry = await invoke(device, 'entry_create', { name: 'Verify entry', entry_type: 'ssh', host: '10.0.0.10', port: 22, ...fields });
  await refreshEntries(device);
  return entry;
}

export async function updateEntry(device, id, patch) {
  const entry = await invoke(device, 'entry_update', { id, ...patch });
  await refreshEntries(device);
  return entry;
}

export async function deleteEntry(device, id) {
  await invoke(device, 'entry_delete', { id });
  await refreshEntries(device);
}

export function listEntries(device) {
  return invoke(device, 'entry_list');
}

/** Opens "Review changes" from the sync indicator or the review banner. */
export async function openConflictReview(device, { timeoutMs = 30_000 } = {}) {
  await waitFor(async () => {
    if (await exists(device, 'button[title="Review changes from your other devices"]')) {
      await clickSelector(device, 'button[title="Review changes from your other devices"]', { timeoutMs: 5_000 });
      return true;
    }
    const text = await bodyText(device, { timeoutMs: 10_000 });
    if (/need(s)? review/.test(text)) {
      await clickText(device, 'Review', { exact: true, selector: 'button', timeoutMs: 5_000 });
      return true;
    }
    return false;
  }, { timeoutMs, label: `${device.name}: a review button` });
  await waitFor(() => exists(device, '[aria-label="Review changes"]'), { timeoutMs: 10_000, label: `${device.name}: review panel` });
}
