// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { ConduitClient } from '../../ipc-client.js';
import { entryInfo } from '../entry.js';
import { credentialRead } from '../credential.js';

function makeClient(response: Record<string, unknown>): ConduitClient {
  return {
    entryGetInfo: vi.fn(async () => response),
    credentialGet: vi.fn(async () => response),
  } as unknown as ConduitClient;
}

const ENTRY = { id: 'e1', name: 'Server', entry_type: 'ssh' };
const CREDENTIAL = { id: 'c1', name: 'Admin', password: 'provisional' };

describe('has_conflict from the app reaches the MCP result', () => {
  it('entry_info passes has_conflict: true through', async () => {
    const out = (await entryInfo(makeClient({ ...ENTRY, has_conflict: true }), { entry_id: 'e1' })) as Record<string, unknown>;
    expect(out.has_conflict).toBe(true);
  });

  it('credential_read passes has_conflict: true through with the provisional value', async () => {
    const out = (await credentialRead(makeClient({ ...CREDENTIAL, revealed: true, has_conflict: true }), { credential_id: 'c1', reveal: true, purpose: 'test' })) as Record<
      string,
      unknown
    >;
    expect(out.has_conflict).toBe(true);
    expect(out.password).toBe('provisional');
  });

  it('reads false when the app leaves it out or sends something else', async () => {
    const entry = (await entryInfo(makeClient(ENTRY), { entry_id: 'e1' })) as Record<string, unknown>;
    const credential = (await credentialRead(makeClient({ ...CREDENTIAL, has_conflict: 'yes' }), { credential_id: 'c1' })) as Record<
      string,
      unknown
    >;
    expect(entry.has_conflict).toBe(false);
    expect(credential.has_conflict).toBe(false);
  });
});
