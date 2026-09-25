/**
 * Fallbacks for Conduit apps older than the TerminalExecute / TerminalSendKeys /
 * TerminalReadScreen IPC requests. They poll the raw line buffer the way the
 * MCP server did before command execution moved into the app.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ConduitClient } from '../ipc-client.js';
import { IpcRequestError } from '../ipc-client.js';
import { stripAnsi } from './terminal-text.js';

export function isUnknownRequest(err: unknown): boolean {
  return err instanceof IpcRequestError && err.code === 'UNKNOWN_REQUEST';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Find a marker at the start of a line (skips the echoed command, where it is mid-line). */
function findAtLineStart(buffer: string, marker: string): number {
  if (buffer.startsWith(marker)) return 0;
  const idx = buffer.indexOf('\n' + marker);
  return idx === -1 ? -1 : idx + 1;
}

export async function legacyExecute(
  client: ConduitClient,
  sessionId: string,
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; exit_code: number | null; timed_out: boolean }> {
  const readyDeadline = Date.now() + Math.min(timeoutMs, 5000);
  while (Date.now() < readyDeadline) {
    const buf = await client.terminalReadBuffer(sessionId, 10);
    if (buf.trim().length > 0) break;
    await sleep(100);
  }

  const markerId = uuidv4().replace(/-/g, '').slice(0, 8);
  const startMarker = `__CONDUIT_START_${markerId}__`;
  const endMarker = `__CONDUIT_END_${markerId}_EXIT_`;
  // Older apps hide lines containing these markers from the user's display.
  const wrapped = `echo '${startMarker}'; ${command}; echo '${endMarker}'"$?"'__'\n`;
  await client.terminalWrite(sessionId, Buffer.from(wrapped));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const buffer = stripAnsi(await client.terminalReadBuffer(sessionId, 500));
    const endPos = findAtLineStart(buffer, endMarker);
    if (endPos !== -1) {
      const afterMarker = buffer.slice(endPos + endMarker.length);
      const codeEnd = afterMarker.indexOf('__');
      const exitCode = codeEnd === -1 ? 0 : parseInt(afterMarker.slice(0, codeEnd), 10) || 0;
      let stdout = '';
      const startPos = findAtLineStart(buffer, startMarker);
      if (startPos !== -1) {
        const nl = buffer.indexOf('\n', startPos);
        const contentStart = nl !== -1 && nl < endPos ? nl + 1 : startPos + startMarker.length;
        if (contentStart < endPos) stdout = buffer.slice(contentStart, endPos).trimEnd();
      }
      return { stdout, exit_code: exitCode, timed_out: false };
    }
    await sleep(100);
  }

  const buffer = stripAnsi(await client.terminalReadBuffer(sessionId, 500).catch(() => ''));
  const startPos = findAtLineStart(buffer, startMarker);
  let stdout = buffer;
  if (startPos !== -1) {
    const nl = buffer.indexOf('\n', startPos);
    stdout = buffer.slice(nl !== -1 ? nl + 1 : startPos + startMarker.length).trimEnd();
  }
  return { stdout, exit_code: null, timed_out: true };
}

export async function legacyReadPane(client: ConduitClient, sessionId: string, lines: number): Promise<string> {
  return stripAnsi(await client.terminalReadBuffer(sessionId, lines));
}

export async function legacySendKeys(
  client: ConduitClient,
  sessionId: string,
  data: Buffer,
  waitMs: number,
): Promise<string> {
  await client.terminalWrite(sessionId, data);
  await sleep(waitMs);
  return stripAnsi(await client.terminalReadBuffer(sessionId, 40)).trimEnd();
}
