// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { ConduitClient } from '../../ipc-client.js';
import { secretReveal, secretRotate } from '../secret.js';

const ID = '11111111-2222-4333-8444-555555555555';

describe('secret tools', () => {
  it('secret_rotate generates by default and keeps an explicit value', async () => {
    const secretRequest = vi.fn(async () => ({}));
    const client = { secretRequest } as unknown as ConduitClient;
    await secretRotate(client, { secret: ID });
    expect(secretRequest).toHaveBeenLastCalledWith('SecretRotate', { secret: ID, generate: true });
    await secretRotate(client, { secret: ID, value: 'given' });
    expect(secretRequest).toHaveBeenLastCalledWith('SecretRotate', { secret: ID, value: 'given', generate: undefined });
  });

  it('secret_reveal accepts a ref and needs a purpose', async () => {
    const credentialGet = vi.fn(async () => ({ name: 'Local admin', password: 'hunter2', revealed: true }));
    const client = { credentialGet } as unknown as ConduitClient;
    await expect(secretReveal(client, { secret: ID, purpose: ' ' })).rejects.toThrow(/purpose/);
    const out = await secretReveal(client, { secret: `{{secret:${ID.toUpperCase()}|Local admin}}`, purpose: 'read aloud' });
    expect(credentialGet).toHaveBeenCalledWith(ID, { purpose: 'read aloud' });
    expect(out).toEqual({ id: ID, name: 'Local admin', value: 'hunter2', revealed: true });
  });
});
