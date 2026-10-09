// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { ConduitClient } from '../../ipc-client.js';
import { credentialRead } from '../credential.js';

const META = { id: 'c1', name: 'Admin', username: 'admin', password_ref: '{{cred:c1}}', has_password: true, revealed: false, password: null };

describe('credential_read', () => {
  it('returns refs and no secret values by default', async () => {
    const credentialGet = vi.fn(async () => ({ ...META, password: 'leak-if-shown' }));
    const out = (await credentialRead({ credentialGet } as unknown as ConduitClient, { credential_id: 'c1' })) as Record<string, unknown>;
    expect(credentialGet).toHaveBeenCalledWith('c1', undefined);
    expect(out.password_ref).toBe('{{cred:c1}}');
    expect('password' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('leak-if-shown');
  });

  it('asks the app to reveal only with a purpose', async () => {
    const credentialGet = vi.fn(async () => ({ ...META, revealed: true, password: 'hunter2' }));
    const client = { credentialGet } as unknown as ConduitClient;
    await expect(credentialRead(client, { credential_id: 'c1', reveal: true })).rejects.toThrow(/purpose/);
    const out = (await credentialRead(client, { credential_id: 'c1', reveal: true, purpose: ' read it to the user ' })) as Record<string, unknown>;
    expect(credentialGet).toHaveBeenCalledWith('c1', { purpose: 'read it to the user' });
    expect(out.password).toBe('hunter2');
  });
});
