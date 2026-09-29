// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_HOLD_MESSAGE, holdMcpUntilInput, isMcpHeld, mcpHeldResponse, releaseMcpHold } from '../mcp-hold.js';

vi.spyOn(console, 'info').mockImplementation(() => undefined);

afterEach(() => releaseMcpHold('test'));

describe('MCP hold after an automatic unlock (docs/AUTO_UNLOCK.md 4.8)', () => {
  it('holds until released, with the locked error', () => {
    expect(isMcpHeld()).toBe(false);
    holdMcpUntilInput();
    expect(isMcpHeld()).toBe(true);
    expect(mcpHeldResponse()).toEqual({ type: 'Error', payload: { code: 'VAULT_LOCKED', message: MCP_HOLD_MESSAGE } });
    releaseMcpHold('key');
    expect(isMcpHeld()).toBe(false);
  });
});
