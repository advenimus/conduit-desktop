/**
 * MCP waits for a person from the start of an automatic unlock (docs/AUTO_UNLOCK.md 4.8): until the first key
 * press or click in the Conduit window, every request but GetTierInfo gets the locked error. A lock
 * or an unlock by a person clears it; only an automatic unlock sets it.
 */

import { VAULT_LOCKED_CODE, type GuardedErrorResponse } from './vault-guard.js';

export const MCP_HOLD_MESSAGE = 'Waiting for you to use Conduit';

let held = false;

export function holdMcpUntilInput(): void {
  if (!held) console.info('[mcp] held until someone uses Conduit');
  held = true;
}

export function releaseMcpHold(reason: string): void {
  if (!held) return;
  held = false;
  console.info('[mcp] hold released', { reason });
}

export function isMcpHeld(): boolean {
  return held;
}

export function mcpHeldResponse(): GuardedErrorResponse {
  return { type: 'Error', payload: { code: VAULT_LOCKED_CODE, message: MCP_HOLD_MESSAGE } };
}
