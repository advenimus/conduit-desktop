import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../env-config.js';

/** Writes to rdp-debug.log in the data folder and to the console. */
export function rdpLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(join(getDataDir(), 'rdp-debug.log'), line);
  } catch {
    /* logging must never break a connect */
  }
  console.log(msg);
}
