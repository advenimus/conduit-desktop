/**
 * Runs an agent-supplied regex in a worker thread with a time limit, so a catastrophic pattern
 * (for example `(a+)+$`) can't freeze the main process.
 */

import { Worker } from 'node:worker_threads';

export const REGEX_TIMEOUT_MS = 1_000;

export class RegexTimeoutError extends Error {}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const match = new RegExp(workerData.pattern, workerData.flags).exec(workerData.text);
  parentPort.postMessage({ ok: true, match: match ? [...match] : null });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e && e.message || e) });
}
`;

/** The match as an array (whole match, then groups), or null. Throws on a bad pattern or the time limit. */
export function execRegexWithTimeout(pattern: string, flags: string, text: string, timeoutMs = REGEX_TIMEOUT_MS): Promise<string[] | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, flags, text } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new RegexTimeoutError(`The pattern took longer than ${timeoutMs} ms. Use a simpler pattern.`));
    }, timeoutMs);
    worker.once('message', (msg: { ok: boolean; match?: string[] | null; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (msg.ok) resolve(msg.match ?? null);
      else reject(new SyntaxError(msg.error ?? 'Invalid regular expression'));
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
