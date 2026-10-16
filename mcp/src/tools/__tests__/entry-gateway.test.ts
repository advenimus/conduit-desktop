// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { ConduitClient } from '../../ipc-client.js';
import { entryInfo } from '../entry.js';

const client = (response: Record<string, unknown>) =>
  ({ entryGetInfo: vi.fn(async () => response) }) as unknown as ConduitClient;

describe('entry_info gateway fields', () => {
  it('passes the gateway an RDP entry uses through', async () => {
    const gateway = { id: 'gw-1', name: 'Corp GW', address: 'gw.corp.example' };
    const out = (await entryInfo(client({ id: 'pc', entry_type: 'rdp', gateway }), { entry_id: 'pc' })) as Record<string, unknown>;
    expect(out.gateway).toEqual(gateway);
    expect(out).not.toHaveProperty('gateway_settings');
  });

  it('passes a gateway entry\'s settings through', async () => {
    const settings = { address: 'gw:8443', hostname: 'gw', port: 8443, transport: 'auto', bypass_local: false, login_source: 'gateway' };
    const out = (await entryInfo(client({ id: 'gw', entry_type: 'credential', gateway_settings: settings }), { entry_id: 'gw' })) as Record<string, unknown>;
    expect(out.gateway_settings).toEqual(settings);
    expect(out).not.toHaveProperty('gateway');
  });
});
