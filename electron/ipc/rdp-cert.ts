// A connection whose certificate the helper could not verify waits here for the dialog's answer.

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import type { CertAnswer } from '../services/rdp/cert-trust/cert-prompts.js';

export const CERT_PROMPT_EVENT = 'rdp:cert_prompt';
export const CERT_PROMPT_RESOLVED_EVENT = 'rdp:cert_prompt_resolved';

const ANSWERS: readonly CertAnswer[] = ['once', 'always', 'cancel'];

export function registerRdpCertHandlers(): void {
  const state = AppState.getInstance();

  const send = (channel: string, payload: unknown): boolean => {
    const win = state.getMainWindow();
    if (!win || win.isDestroyed()) return false;
    win.webContents.send(channel, payload);
    return true;
  };

  state.rdpCertPrompts.setNotifier({
    requested: (info) => {
      if (!send(CERT_PROMPT_EVENT, info)) return false;
      const win = state.getMainWindow();
      if (win && !win.isFocused()) win.flashFrame(true);
      return true;
    },
    resolved: (requestId, outcome) => {
      send(CERT_PROMPT_RESOLVED_EVENT, { request_id: requestId, outcome });
    },
  });

  ipcMain.handle('rdp_cert_prompt_respond', async (_e, args: { request_id?: unknown; answer?: unknown }) => {
    const requestId = typeof args?.request_id === 'string' ? args.request_id : '';
    const answer = ANSWERS.includes(args?.answer as CertAnswer) ? (args.answer as CertAnswer) : null;
    if (!requestId || !answer) throw new Error('Not a valid answer to the certificate question');
    if (!state.rdpCertPrompts.answer(requestId, answer)) {
      throw new Error('This certificate question already timed out or was answered');
    }
    return true;
  });

  // The renderer asks on mount, so a question that came before the dialog loaded is not lost.
  ipcMain.handle('rdp_cert_prompt_list_pending', async () => state.rdpCertPrompts.listPending());
}
