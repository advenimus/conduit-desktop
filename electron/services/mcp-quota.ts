/**
 * Desktop-side access to the MCP daily-quota ledger written by
 * mcp/src/daily-quota.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getMcpStateDir } from './env-config.js';

export function getMcpQuotaFilePath(): string {
  return path.join(getMcpStateDir(), 'mcp-quota.json');
}

/**
 * Dev builds start each launch with a fresh MCP quota so tools can be tested
 * without hitting the free-tier cap. Packaged builds keep the ledger.
 * Returns true when the ledger was cleared.
 */
export function resetMcpQuotaForDevLaunch(isPackaged: boolean): boolean {
  if (isPackaged) return false;
  fs.rmSync(getMcpQuotaFilePath(), { force: true });
  return true;
}
