// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ConduitClient } from '../../ipc-client.js';
import { connectionList, connectionOpenEntry } from '../connection.js';

function makeClient(overrides: Partial<Record<keyof ConduitClient, unknown>>): ConduitClient {
  return overrides as unknown as ConduitClient;
}

const ssh = { id: 's1', entry_id: 'e1', name: 'Web', connection_type: 'ssh', host: 'h', port: 22, status: 'connected' };

describe('connection_list owner', () => {
  it('passes owner through and tells the agent what to do with another agent\'s session', async () => {
    const client = makeClient({
      connectionList: vi.fn(async () => [
        { ...ssh, owner: 'other_agent' },
        { ...ssh, id: 's2', owner: 'you' },
        { ...ssh, id: 'r1', connection_type: 'rdp', owner: 'other_agent' },
      ]),
    });
    const { connections } = (await connectionList(client)) as { connections: Array<Record<string, unknown>> };
    expect(connections[0]).toMatchObject({ id: 's1', owner: 'other_agent' });
    expect(connections[0].note).toContain('connection_open_entry');
    expect(connections[1]).toMatchObject({ id: 's2', owner: 'you' });
    expect(connections[1].note).toBeUndefined();
    expect(connections[2].note).toContain('tell the user');
  });

  it('adds no owner when the app is older and sends none', async () => {
    const client = makeClient({ connectionList: vi.fn(async () => [ssh]) });
    const { connections } = (await connectionList(client)) as { connections: Array<Record<string, unknown>> };
    expect(connections[0]).not.toHaveProperty('owner');
    expect(connections[0]).not.toHaveProperty('note');
  });
});

describe('connection_open_entry reuse', () => {
  it('says when the app returned the entry\'s open session', async () => {
    const client = makeClient({
      connectionOpenEntry: vi.fn(async () => ({ session_id: 'r1', entry_id: 'e2', connection_type: 'rdp', status: 'connected', reused: true })),
    });
    expect(await connectionOpenEntry(client, { entry_id: 'e2' })).toMatchObject({ id: 'r1', reused: true });
  });

  it('leaves reused out for a new session', async () => {
    const client = makeClient({
      connectionOpenEntry: vi.fn(async () => ({ session_id: 's9', connection_type: 'ssh', status: 'connected' })),
    });
    expect(await connectionOpenEntry(client, { entry_id: 'e1' })).not.toHaveProperty('reused');
  });
});
