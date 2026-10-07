/** IPC handlers for secret chips in notes and knowledge articles (docs/KNOWLEDGE_BASE.md 3). */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import { readEmbedded } from '../services/knowledge/kb-model.js';
import {
  cleanupOrphans,
  createEmbeddedSecret,
  encryptAllPlaintext,
  ownedSecrets,
  updateWithSecrets,
} from '../services/secrets/embedded-secrets.js';
import { generateSecret, type GenerateOptions } from '../services/secrets/secret-generate.js';

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export function registerSecretHandlers(): void {
  const state = AppState.getInstance();
  const vault = () => state.getActiveVault();
  const changedBy = () => state.authService?.getAuthState()?.user?.email ?? null;

  ipcMain.handle('secret_create', async (_e, args: { owner_id: string; label: string; value?: string; generate?: GenerateOptions }) => {
    const value = args.generate ? generateSecret(args.generate) : requireText(args.value, 'value');
    return createEmbeddedSecret(vault(), requireText(args.owner_id, 'owner_id'), args.label ?? '', value);
  });

  ipcMain.handle('secret_rename', async (_e, args: { id: string; label: string }) => {
    const v = vault();
    const entry = v.getEntryMeta(args.id);
    const embedded = readEmbedded(entry.config);
    if (!embedded) throw new Error('Not an embedded secret');
    const label = requireText(args.label?.trim(), 'label').slice(0, 80);
    return v.updateEntry(args.id, { name: label, config: { ...entry.config, embedded: { ...embedded, label } } });
  });

  ipcMain.handle('secret_set_value', async (_e, args: { id: string; value: string }) => {
    const v = vault();
    const current = v.getEntry(args.id);
    if (!readEmbedded(current.config)) throw new Error('Not an embedded secret');
    v.recordPasswordHistory(args.id, current.username, current.password, changedBy());
    return v.updateEntry(args.id, { password: requireText(args.value, 'value') });
  });

  ipcMain.handle('secret_list_owned', async (_e, args: { owner_id: string }) =>
    ownedSecrets(vault(), args.owner_id).map((s) => ({ id: s.id, name: s.name, embedded: readEmbedded(s.config) })),
  );

  ipcMain.handle('secret_cleanup_orphans', async (_e, args: { owner_id: string }) => cleanupOrphans(vault(), args.owner_id));

  ipcMain.handle('secret_encrypt_entry', async (_e, args: { id: string }) => {
    const v = vault();
    const entry = v.getEntryMeta(args.id);
    return updateWithSecrets(v, args.id, { notes: entry.notes, config: entry.config }).converted;
  });

  ipcMain.handle('secret_encrypt_all', async () => encryptAllPlaintext(vault()));
}
