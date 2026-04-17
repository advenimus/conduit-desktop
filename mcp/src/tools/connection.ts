/**
 * Connection MCP tools.
 *
 * Port of crates/conduit-mcp/src/tools/connection.rs + server.rs connection methods.
 */

import type { ConduitClient } from '../ipc-client.js';

// ---------- connection_list ----------

export function connectionListDefinition() {
  return {
    name: 'connection_list',
    description:
      'List all connections (active and saved). Returns id (session ID for terminal/RDP/VNC/web tools) and entry_id (vault entry ID for entry_info, entry_update_notes, document_read tools). ' +
      'Active connections can be used directly with terminal tools. ' +
      'Saved connections with status "disconnected" must first be opened with connection_open before use.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

export async function connectionList(client: ConduitClient): Promise<unknown> {
  const connections = await client.connectionList();

  return {
    connections: connections.map((c) => ({
      id: c.id,
      entry_id: c.entry_id ?? c.id,
      name: c.name,
      connection_type: c.connection_type,
      host: c.host ?? null,
      port: c.port ?? null,
      status: c.status ?? 'unknown',
      ...(c.status === 'disconnected'
        ? { note: 'Use connection_open with this host/port to connect before using terminal tools' }
        : {}),
    })),
  };
}

// ---------- connection_open ----------

export function connectionOpenDefinition() {
  return {
    name: 'connection_open',
    description: 'Open a new connection (SSH, RDP, or VNC)',
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
  return {
    success: true,
    closed_id: args.connection_id,
  };
}
