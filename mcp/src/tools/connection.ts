/**
 * Connection MCP tools.
 *
 * Port of crates/conduit-mcp/src/tools/connection.rs + server.rs connection methods.
 */

import type { ConduitClient } from '../ipc-client.js';
import { invalidateRdpScale } from './rdp.js';
import { invalidateVncScale } from './vnc.js';
import { invalidateWebScale } from './web.js';

// ---------- connection_list ----------

export function connectionListDefinition() {
  return {
    name: 'connection_list',
    description:
      'List all connections (active and saved). Returns id (session ID for terminal/RDP/VNC/web tools) and entry_id (vault entry ID for entry_info, entry_update_notes, document_read tools). ' +
      'Active connections can be used directly with terminal tools. ' +
      'Saved connections with status "disconnected" must first be opened with connection_open_entry (pass the entry_id; credentials are resolved server-side) before use. ' +
      'Other AI agents may be working at the same time: owner is "you" for sessions you opened or used, "other_agent" when another agent is working in it ' +
      '(do not type, click or run commands there), and "free" otherwise.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

const SHARED_SCREEN_TYPES = new Set(['rdp', 'vnc', 'web']);

function connectionNote(c: Record<string, unknown>): string | null {
  if (c.status === 'disconnected') {
    return 'Use connection_open_entry with this entry_id to open this saved connection (credentials resolved server-side) before using terminal tools';
  }
  if (c.owner !== 'other_agent') return null;
  if (SHARED_SCREEN_TYPES.has(c.connection_type as string)) {
    return 'Another agent is working in this session. Do not use it or open a second one; tell the user it is busy.';
  }
  return 'Another agent is working in this session. Do not use it; open your own with connection_open_entry (this entry_id) or local_shell_create.';
}

export async function connectionList(client: ConduitClient): Promise<unknown> {
  const connections = await client.connectionList();

  return {
    connections: connections.map((c) => {
      const note = connectionNote(c);
      return {
        id: c.id,
        entry_id: c.entry_id ?? c.id,
        name: c.name,
        connection_type: c.connection_type,
        host: c.host ?? null,
        port: c.port ?? null,
        status: c.status ?? 'unknown',
        // Apps without session ownership send no owner.
        ...(typeof c.owner === 'string' ? { owner: c.owner } : {}),
        ...(note ? { note } : {}),
      };
    }),
  };
}

// ---------- connection_open ----------

export function connectionOpenDefinition() {
  return {
    name: 'connection_open',
    description:
      'Open a new connection (SSH, RDP, or VNC) by specifying host/port/credentials manually. ' +
      'To open a connection already saved in the vault, prefer connection_open_entry, which resolves ' +
      'host, port, and credentials from the saved entry by its entry_id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_type: {
          type: 'string',
          description: 'Connection type: ssh, rdp, vnc',
        },
        host: { type: 'string', description: 'Host to connect to' },
        port: {
          type: 'number',
          description: 'Port (default depends on type: SSH=22, RDP=3389, VNC=5900)',
        },
        credential_id: {
          type: 'string',
          description: 'Credential ID from the vault to use for authentication',
        },
        username: {
          type: 'string',
          description: 'Username for authentication (used if credential_id is not provided)',
        },
        password: {
          type: 'string',
          description: 'Password for authentication (used with username if credential_id is not provided)',
        },
        name: {
          type: 'string',
          description: 'Connection name (optional, will be auto-generated if not provided)',
        },
        ssh_auth_method: {
          type: 'string',
          description: 'SSH auth method override: "key" or "password". Used when credential has both an SSH key and a password.',
        },
      },
      required: ['connection_type', 'host'],
    },
  };
}

export async function connectionOpen(
  client: ConduitClient,
  args: {
    connection_type: string;
    host: string;
    port?: number;
    credential_id?: string;
    username?: string;
    password?: string;
    name?: string;
    ssh_auth_method?: string;
  },
): Promise<unknown> {
  // Determine default port based on connection type
  const port =
    args.port ??
    (() => {
      switch (args.connection_type) {
        case 'ssh':
          return 22;
        case 'rdp':
          return 3389;
        case 'vnc':
          return 5900;
        default:
          return 22;
      }
    })();

  const connection = await client.connectionOpen(
    args.connection_type,
    args.host,
    port,
    args.credential_id ?? null,
    args.username ?? null,
    args.password ?? null,
    args.ssh_auth_method ?? null,
  );

  return {
    id: connection.session_id ?? connection.id,
    name: connection.name,
    connection_type: connection.connection_type,
    host: args.host,
    port,
    status: connection.status,
  };
}

// ---------- connection_open_entry ----------

export function connectionOpenEntryDefinition() {
  return {
    name: 'connection_open_entry',
    description:
      'Open a saved connection from the vault by its entry_id. Host, port, and credentials are ' +
      'resolved from the saved entry on the server side — no need to look up or pass credentials. ' +
      'Works for ssh, rdp, and vnc entries. The vault must be unlocked. ' +
      'Get entry_id values from connection_list, entry_list, or entry_search. ' +
      'SSH always opens a new session of your own, so use it when another agent is working in that entry\'s session. ' +
      'RDP and VNC return the entry\'s open session when no other agent is using it (reused: true), and fail with ' +
      'SESSION_IN_USE when one is: then tell the user instead of retrying.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: {
          type: 'string',
          description: 'Vault entry ID of the saved ssh/rdp/vnc connection to open',
        },
        ssh_auth_method: {
          type: 'string',
          description:
            'Optional SSH auth method override: "key" or "password". Used when the entry\'s credential ' +
            'has both an SSH key and a password. Defaults to the entry\'s saved preference.',
        },
      },
      required: ['entry_id'],
    },
  };
}

export async function connectionOpenEntry(
  client: ConduitClient,
  args: { entry_id: string; ssh_auth_method?: string },
): Promise<unknown> {
  const connection = await client.connectionOpenEntry(args.entry_id, args.ssh_auth_method ?? null);

  return {
    id: connection.session_id ?? connection.id,
    entry_id: connection.entry_id ?? args.entry_id,
    name: connection.name ?? null,
    connection_type: connection.connection_type,
    host: connection.host ?? null,
    port: connection.port ?? null,
    status: connection.status,
    ...(connection.width !== undefined ? { width: connection.width } : {}),
    ...(connection.height !== undefined ? { height: connection.height } : {}),
    ...(connection.reused === true ? { reused: true } : {}),
  };
}

// ---------- connection_close ----------

export function connectionCloseDefinition() {
  return {
    name: 'connection_close',
    description: 'Close an active connection',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the connection to close' },
      },
      required: ['connection_id'],
    },
  };
}

export async function connectionClose(
  client: ConduitClient,
  args: { connection_id: string },
): Promise<unknown> {
  await client.connectionClose(args.connection_id);
  // Drop cached scale factors so a reopen under the same id doesn't reuse stale ones.
  invalidateRdpScale(args.connection_id);
  invalidateVncScale(args.connection_id);
  invalidateWebScale(args.connection_id);
  return {
    success: true,
    closed_id: args.connection_id,
  };
}
