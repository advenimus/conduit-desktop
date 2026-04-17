/**
 * IPC handler registration for Electron main process.
 */

import { AppState } from '../services/state.js';
import { registerAiHandlers } from './ai.js';
import { registerApprovalHandlers } from './approval.js';
import { registerEntryHandlers } from './entry.js';
import { registerFolderHandlers } from './folder.js';
import { registerRdpHandlers } from './rdp.js';
import { registerSettingsHandlers } from './settings.js';
import { registerTerminalHandlers } from './terminal.js';
import { registerUiStateHandlers } from './ui-state.js';
import { registerMenuHandlers } from './menu.js';
import { registerUpdaterHandlers } from './updater.js';
import { registerVaultHandlers } from './vault.js';
import { registerVncHandlers } from './vnc.js';
import { registerWebHandlers } from './web.js';
import { registerAuthHandlers } from './auth.js';
import { registerCloudSyncHandlers } from './cloud-sync.js';
import { registerChatCloudSyncHandlers } from './chat-cloud-sync.js';
import { registerImportHandlers } from './import.js';
import { registerExportImportHandlers } from './export-import.js';
import { registerLocalBackupHandlers } from './local-backup.js';
import { registerEngineHandlers } from './engine.js';
import { registerTeamCryptoHandlers } from './team-crypto.js';
import { registerTeamHandlers } from './team.js';
import { registerTeamVaultHandlers } from './team-vault.js';
import { registerSshKeygenHandlers } from './ssh-keygen.js';
import { registerFeedbackHandlers } from './feedback.js';
import { registerCommandHandlers } from './command.js';
import { registerPasswordHistoryHandlers } from './password-history.js';
import { registerAutotypeHandlers } from './autotype.js';
import { registerBiometricHandlers } from './biometric.js';

export function registerIpcHandlers(): void {
  const state = AppState.getInstance();

  // ── Entry commands (replaces connection) ──────────────────────────
  registerEntryHandlers();

  // ── Folder commands ───────────────────────────────────────────────
  registerFolderHandlers();

  // ── Terminal commands ────────────────────────────────────────────────
  registerTerminalHandlers();

  // ── Vault + Credential commands ─────────────────────────────────────
  registerVaultHandlers();

  // ── Approval commands ───────────────────────────────────────────────
  registerApprovalHandlers();

  // ── AI commands ─────────────────────────────────────────────────────
  registerAiHandlers(state);

  // ── RDP commands ────────────────────────────────────────────────────
  registerRdpHandlers();

  // ── VNC commands ────────────────────────────────────────────────────
  registerVncHandlers();

  // ── Web session commands ────────────────────────────────────────────
  registerWebHandlers();

  // ── Settings commands ───────────────────────────────────────────────
  registerSettingsHandlers();

  // ── UI state persistence ─────────────────────────────────────────────
  registerUiStateHandlers();

  // ── Popup context menu ─────────────────────────────────────────────
  registerMenuHandlers();

  // ── Updater commands ────────────────────────────────────────────────
  registerUpdaterHandlers();

  // ── Auth commands ────────────────────────────────────────────────
  registerAuthHandlers();

  // ── Cloud sync commands ────────────────────────────────────────────
  registerCloudSyncHandlers();

  // ── Chat cloud sync commands ────────────────────────────────────────
  registerChatCloudSyncHandlers();

  // ── Import commands ───────────────────────────────────────────────
  registerImportHandlers();

  // ── Vault export/import commands ────────────────────────────────
  registerExportImportHandlers();

  // ── Local backup commands ──────────────────────────────────────────
  registerLocalBackupHandlers();

  // ── Engine commands (unified AI engine abstraction) ────────────────
  registerEngineHandlers(state);

  // ── Team crypto / identity key commands ──────────────────────────
  registerTeamCryptoHandlers();

  // ── Team management commands ────────────────────────────────────
  registerTeamHandlers();

  // ── Team vault commands ───────────────────────────────────────
  registerTeamVaultHandlers();

  // ── SSH key generation commands ─────────────────────────────
  registerSshKeygenHandlers();

  // ── Feedback / bug report commands ───────────────────────────
  registerFeedbackHandlers();

  // ── Command execution commands ──────────────────────────────
  registerCommandHandlers();

  // ── Password history commands ─────────────────────────────
  registerPasswordHistoryHandlers();

  // ── Biometric (Touch ID / Windows Hello) commands ────────
  registerBiometricHandlers();

  // ── Global auto-type commands ─────────────────────────────
  registerAutotypeHandlers();
}
