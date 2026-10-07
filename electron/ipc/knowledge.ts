/** IPC handlers for the knowledge base screens (docs/KNOWLEDGE_BASE.md). Reads happen in the renderer from the entry store. */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import type { KbEditorRef } from '../services/knowledge/kb-model.js';
import {
  createArticle,
  keepAgentEdits,
  requireArticle,
  restoreRevision,
  undoAgentEdits,
  updateArticle,
  verifyArticle,
  type ArticleChanges,
  type KbVault,
  type NewArticle,
} from '../services/knowledge/kb-store.js';
import { dismissMigration, logChange, splitNotesIntoArticles } from '../services/knowledge/kb-notes.js';

const ME: KbEditorRef = { kind: 'user', device: 'desktop' };

export function registerKnowledgeHandlers(): void {
  const state = AppState.getInstance();
  const vault = () => state.getActiveVault() as unknown as KbVault;

  ipcMain.handle('kb_create', async (_e, args: NewArticle) => createArticle(vault(), args, ME));
  ipcMain.handle('kb_update', async (_e, args: { id: string } & ArticleChanges) => {
    const { id, ...changes } = args;
    return updateArticle(vault(), id, changes, ME);
  });
  ipcMain.handle('kb_verify', async (_e, args: { id: string; still_true: boolean; note?: string }) =>
    verifyArticle(vault(), args.id, args.still_true, args.note, ME));
  ipcMain.handle('kb_keep', async (_e, args: { id: string }) => keepAgentEdits(vault(), args.id));
  ipcMain.handle('kb_undo', async (_e, args: { id: string }) => undoAgentEdits(vault(), args.id));
  ipcMain.handle('kb_restore', async (_e, args: { id: string; at: string }) => restoreRevision(vault(), args.id, args.at));
  ipcMain.handle('kb_delete', async (_e, args: { id: string }) => {
    requireArticle(vault(), args.id);
    vault().deleteEntry(args.id);
  });
  ipcMain.handle('kb_split_notes', async (_e, args: { entry_id: string; notes_after: 'keep' | 'pointer' }) =>
    splitNotesIntoArticles(vault(), args.entry_id, args.notes_after === 'pointer' ? 'pointer' : 'keep').length);
  ipcMain.handle('kb_dismiss_migration', async (_e, args: { entry_id: string }) => dismissMigration(vault(), args.entry_id));
  ipcMain.handle('kb_log', async (_e, args: { entry_id: string; text: string }) => logChange(vault(), args.entry_id, args.text, ME));
}
