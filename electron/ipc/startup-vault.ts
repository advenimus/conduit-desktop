/**
 * The startup vault and automatic unlock in main (docs/AUTO_UNLOCK.md 4): the one-shot startup
 * attempt, the escape hatch, the re-arm after a close, the MCP hold, the proof record for turning
 * it on, and the IPC channels. The decisions live in startup-vault-core.ts, auto-unlock-open.ts,
 * auto-unlock-enable.ts and auto-unlock-lifecycle.ts; this file connects them to Electron.
 */

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { ipcMain, type BrowserWindow } from 'electron';
import { AppState } from '../services/state.js';
import { getAutoUnlockStore } from '../services/vault/auto-unlock-electron.js';
import { getBiometricService } from '../services/vault/biometric.js';
import { StartupSkip, probeMacModifiers } from '../services/vault/startup-modifiers.js';
import { holdMcpUntilInput, releaseMcpHold } from '../ipc-server/mcp-hold.js';
import { readSettings, updateRecentVaults, writeSettings } from './settings.js';
import { StartupAttempt, decidePlan, parseStartupVault, type StartupPlan, type StartupVault } from './startup-vault-core.js';
import { onPersonalLocked, onPersonalUnlocked } from './vault-events.js';
import { lockPersonalVault } from './vault-lock-flow.js';
import { openPersonalAndFinish } from './vault-unlock.js';
import { parseAutoUnlockArgs, runAutoUnlock } from './auto-unlock-open.js';
import { enableAutoUnlock, parseProof } from './auto-unlock-enable.js';
import { isBiometricEnabledForPath } from './biometric-lineage.js';
import { watchAccountChange, type AutoUnlockEvent, type LifecycleDeps } from './auto-unlock-lifecycle.js';

export const STARTUP_AGAIN_EVENT = 'vault-startup-again';
export const AUTO_UNLOCK_EVENT = 'auto-unlock-event';
const PROOF_WINDOW_MS = 120_000;
const INTERACTIVE_SOURCES: ReadonlySet<string> = new Set(['vault_unlock', 'biometric_unlock', 'vault_create', 'vault_initialize']);
const LOG = '[startup-vault]';

export interface StartupStatus {
  readonly platform: NodeJS.Platform;
  readonly store: { readonly usable: boolean; readonly reason: string; readonly storeName: string };
  readonly startupVault: StartupVault | null;
  /** Path of the vault with a saved unlock (always the startup vault), else null. */
  readonly savedPath: string | null;
  /** The open personal vault is the one with the saved unlock. */
  readonly currentOn: boolean;
}

const attempt = new StartupAttempt(() => Date.now());
let skip = new StartupSkip(process.platform, false);
let launchHasUrl = false;
let firstShowSeen = false;
let recentUnlock: { readonly lineageId: string; readonly at: number } | null = null;
let probeDone: Promise<void> = Promise.resolve();

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

export function readStartupVault(): StartupVault | null {
  return parseStartupVault(readSettings().startup_vault);
}

export function writeStartupVault(next: StartupVault | null): void {
  writeSettings({ ...readSettings(), startup_vault: next });
}

function sendToRenderer(channel: string, payload?: unknown): void {
  const win = AppState.getInstance().getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

export function lifecycleDeps(state: AppState = AppState.getInstance()): LifecycleDeps {
  return {
    store: getAutoUnlockStore(),
    readStartup: readStartupVault,
    writeStartup: writeStartupVault,
    notify: (event: AutoUnlockEvent) => sendToRenderer(AUTO_UNLOCK_EVENT, event),
    lineageForPath: (p) => state.appSync.lineageForPath(p),
    currentLineageId: () => state.appSync.currentLineageId(),
    currentPath: () => state.currentVaultPath,
    userId: () => state.authService.getAuthState().user?.id ?? null,
  };
}

async function runProbe(target: StartupSkip): Promise<void> {
  const held = await probeMacModifiers(
    (command, args, timeoutMs) =>
      new Promise((resolve, reject) => {
        execFile(command, [...args], { timeout: timeoutMs }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
      }),
  );
  target.setProbeResult(held);
  if (held) console.info(`${LOG} modifier held at launch: skipping the startup vault`);
}

/** Called once at whenReady: the switch, and the macOS modifier probe (the plan waits for it). */
export function initStartupVault(opts: { readonly switchSet: boolean }): void {
  skip = new StartupSkip(process.platform, opts.switchSet);
  if (opts.switchSet) console.info(`${LOG} --no-startup-vault: skipping the startup vault`);
  if (process.platform === 'darwin') probeDone = runProbe(skip);
}

/** A conduit:// link arrived before the app was ready: this start never unlocks by itself. */
export function noteLaunchUrl(): void {
  launchHasUrl = true;
}

/** The escape-hatch collector, the re-arm on show, and key presses that release the MCP hold. */
export function attachStartupWindow(win: BrowserWindow): void {
  win.on('show', () => {
    const now = Date.now();
    if (!firstShowSeen) {
      firstShowSeen = true;
      skip.startCollector(now);
      return;
    }
    if (!attempt.shown()) return;
    skip.rearm(now);
    console.info(`${LOG} window shown again after a close: startup vault re-armed`);
    if (!win.isDestroyed()) win.webContents.send(STARTUP_AGAIN_EVENT);
  });
  win.webContents.on('before-input-event', (_event, input) => {
    if (skip.noteInput(input, Date.now())) return;
    if (input.type === 'keyDown') releaseMcpHold('key');
  });
}

/** A second launch never re-arms with a link or a vault file on its command line (spec 4.6). */
export function noteSecondInstance(commandLine: readonly string[]): void {
  if (commandLine.some((arg) => arg.startsWith('conduit://') || arg.endsWith('.conduit'))) attempt.cancelRearm();
}

export async function buildStartupStatus(state: AppState = AppState.getInstance()): Promise<StartupStatus> {
  const store = getAutoUnlockStore();
  const s = store.status();
  const sv = readStartupVault();
  const savedPath = sv?.kind === 'personal' && sv.lineageId !== null && store.hasEntry(sv.lineageId) ? sv.path : null;
  let currentOn = false;
  if (savedPath !== null && sv?.kind === 'personal' && state.vault.isUnlocked() && state.teamVaultManager.getActiveVault() === null) {
    const lineage = state.appSync.currentLineageId();
    currentOn = lineage !== null ? lineage === sv.lineageId : state.currentVaultPath === savedPath;
  }
  return { platform: process.platform, store: { usable: s.usable, reason: s.reason, storeName: s.storeName }, startupVault: sv, savedPath, currentOn };
}

async function lineageMatches(state: AppState, sv: StartupVault): Promise<boolean> {
  if (sv.kind !== 'personal' || sv.lineageId === null) return false;
  try {
    return (await state.appSync.lineageForPath(sv.path)) === sv.lineageId;
  } catch (err) {
    console.warn(`${LOG} lineage lookup for the startup vault failed`, { name: errName(err) });
    return false;
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function makePlan(state: AppState): Promise<StartupPlan> {
  if (!attempt.consume()) return { kind: 'none' };
  await probeDone;
  const settings = readSettings();
  const sv = parseStartupVault(settings.startup_vault);
  const store = getAutoUnlockStore();
  store.removeAllExcept(sv?.kind === 'personal' ? sv.lineageId : null);
  if (sv !== null && sv.kind !== 'hub') await delay(skip.remainingMs(Date.now()));
  const personal = sv?.kind === 'personal' ? sv : null;
  const plan = decidePlan({
    skipRequested: skip.isSkipRequested(),
    startupVault: sv,
    lastVaultType: settings.last_vault_type,
    fileExists: personal !== null && fs.existsSync(personal.path),
    lineageMatches: personal !== null && (await lineageMatches(state, personal)),
    launchHasUrl,
    entryExists: personal?.lineageId != null && store.hasEntry(personal.lineageId),
    storeUsable: store.status().usable,
  });
  if (plan.kind !== 'personal' || !plan.auto) attempt.finish();
  console.info(`${LOG} startup plan`, { kind: plan.kind, auto: plan.kind === 'personal' ? plan.auto : false, skipped: plan.kind === 'hub' && plan.skipped !== undefined });
  return plan;
}

function autoUnlockDeps(state: AppState) {
  return {
    store: getAutoUnlockStore(),
    attempt,
    readStartup: readStartupVault,
    authInitialized: () => state.authService.hasInitialized(),
    userId: () => state.authService.getAuthState().user?.id ?? null,
    currentPath: () => state.currentVaultPath,
    prepare: async (p: string) => {
      await lockPersonalVault(state);
      state.switchVault(p);
      updateRecentVaults(p);
    },
    open: (req: Parameters<typeof openPersonalAndFinish>[1], onRefused: Parameters<typeof openPersonalAndFinish>[2]) => openPersonalAndFinish(state, req, onRefused),
    holdMcp: holdMcpUntilInput,
  };
}

function enableDeps(state: AppState) {
  return {
    store: getAutoUnlockStore(),
    isPersonalUnlocked: () => state.vault.isUnlocked() && state.teamVaultManager.getActiveVault() === null,
    currentPath: () => state.currentVaultPath,
    currentLineage: async () => {
      try {
        return (await state.appSync.lineageForPath(state.currentVaultPath)) ?? state.appSync.currentLineageId();
      } catch {
        return state.appSync.currentLineageId();
      }
    },
    masterPassword: () => state.currentMasterPassword,
    consumeRecentUnlock: (lineageId: string) => {
      const rec = recentUnlock;
      recentUnlock = null;
      return rec !== null && rec.lineageId === lineageId && Date.now() - rec.at < PROOF_WINDOW_MS;
    },
    biometricEnabledForCurrent: () => isBiometricEnabledForPath(state, state.currentVaultPath),
    authenticateBiometric: (reason: string) => getBiometricService().authenticate(reason),
    userId: () => state.authService.getAuthState().user?.id ?? null,
    writeStartup: writeStartupVault,
  };
}

function record(args: unknown): Readonly<Record<string, unknown>> {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

/** startup_vault_set: 'automatic' (null), 'hub', { personal path } or { team id }. */
async function parseChoice(state: AppState, args: unknown): Promise<StartupVault | null> {
  const a = record(args);
  if (a.kind === 'automatic') return null;
  if (a.kind === 'hub') return { kind: 'hub' };
  if (a.kind === 'team' && typeof a.teamVaultId === 'string' && a.teamVaultId !== '') return { kind: 'team', teamVaultId: a.teamVaultId };
  if (a.kind === 'personal' && typeof a.path === 'string') {
    let lineageId: string | null = null;
    try {
      lineageId = await state.appSync.lineageForPath(a.path);
    } catch (err) {
      console.warn(`${LOG} lineage lookup for a new startup vault failed`, { name: errName(err) });
    }
    const parsed = parseStartupVault({ kind: 'personal', path: a.path, lineageId });
    if (parsed !== null) return parsed;
  }
  throw new Error('Choose a vault to open at startup.');
}

function sameStartup(a: StartupVault | null, b: StartupVault | null): boolean {
  if (a?.kind === 'personal' && b?.kind === 'personal') return a.path === b.path;
  return JSON.stringify(a) === JSON.stringify(b);
}

async function setStartup(state: AppState, args: unknown): Promise<{ status: StartupStatus; forgot: boolean }> {
  const next = await parseChoice(state, args);
  const prev = readStartupVault();
  const store = getAutoUnlockStore();
  const forgot = !sameStartup(prev, next) && store.removeAll() > 0;
  writeStartupVault(next);
  console.info(`${LOG} startup vault set`, { kind: next?.kind ?? 'automatic', forgot });
  return { status: await buildStartupStatus(state), forgot };
}

function listenForUnlockAndLock(): void {
  onPersonalUnlocked(({ source, lineageId }) => {
    if (source === 'auto_unlock') return;
    attempt.userUnlocked();
    releaseMcpHold('unlock');
    recentUnlock = INTERACTIVE_SOURCES.has(source) ? { lineageId, at: Date.now() } : null;
  });
  onPersonalLocked(({ cause }) => {
    attempt.locked(cause === 'window-close', true);
    releaseMcpHold('lock');
    recentUnlock = null;
  });
}

export function registerStartupVaultHandlers(): void {
  const state = AppState.getInstance();
  listenForUnlockAndLock();
  watchAccountChange(state.authService, lifecycleDeps(state));

  ipcMain.handle('vault_startup_plan', () => makePlan(state));
  ipcMain.handle('vault_startup_done', () => {
    attempt.finish();
  });
  ipcMain.handle('vault_startup_cancel', async () => {
    attempt.finish();
    await lockPersonalVault(state);
  });
  ipcMain.handle('startup_input_focus', () => {
    skip.noteInputFocus();
  });
  ipcMain.handle('startup_user_present', (_e, args) => {
    if (record(args).kind === 'pointer' || !skip.isCollecting(Date.now())) releaseMcpHold('input');
  });
  ipcMain.handle('startup_vault_get', () => buildStartupStatus(state));
  ipcMain.handle('auto_unlock_status', () => buildStartupStatus(state));
  ipcMain.handle('startup_vault_set', (_e, args) => setStartup(state, args));
  ipcMain.handle('auto_unlock_enabled_for_path', async (_e, args) => {
    const vaultPath = record(args).vaultPath;
    return typeof vaultPath === 'string' && (await buildStartupStatus(state)).savedPath === vaultPath;
  });
  ipcMain.handle('auto_unlock_enable', async (_e, args) => {
    await enableAutoUnlock(enableDeps(state), parseProof(args));
    return buildStartupStatus(state);
  });
  ipcMain.handle('auto_unlock_disable', async () => {
    const removed = getAutoUnlockStore().removeAll();
    console.info('[auto-unlock] turned off', { removed });
    return buildStartupStatus(state);
  });
  ipcMain.handle('vault_auto_unlock', (_e, args) => runAutoUnlock(autoUnlockDeps(state), parseAutoUnlockArgs(args)));
}
