/**
 * Credential MCP tools.
 *
 * Port of crates/conduit-mcp/src/tools/credential.rs + server.rs credential methods.
 */

import type { ConduitClient } from '../ipc-client.js';

// ---------- credential_list ----------

export function credentialListDefinition() {
  return {
    name: 'credential_list',
    description: 'List all stored credentials (metadata only, no secrets)',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

export async function credentialList(client: ConduitClient): Promise<unknown> {
  const credentials = await client.credentialList();

  return {
    credentials: credentials.map((c) => ({
      id: c.id,
      name: c.name,
      username: c.username ?? null,
      has_password: c.has_password ?? false,
      has_private_key: c.has_private_key ?? false,
      has_totp: c.has_totp ?? false,
      domain: c.domain ?? null,
      tags: c.tags ?? [],
      credential_type: c.credential_type ?? null,
      created_at: c.created_at ?? '',
    })),
  };
}

// ---------- credential_create ----------

export function credentialCreateDefinition() {
  return {
    name: 'credential_create',
    description: 'Store a new credential',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Credential name' },
        username: { type: 'string', description: 'Username' },
        password: { type: 'string', description: 'Password (encrypted at rest)' },
        domain: { type: 'string', description: 'Domain (for Windows auth)' },
        private_key: { type: 'string', description: 'SSH private key' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for organization',
          default: [],
        },
        credential_type: {
          type: 'string',
          description: 'Credential type: "generic" (default) or "ssh_key"',
          enum: ['generic', 'ssh_key'],
        },
        public_key: {
          type: 'string',
          description: 'SSH public key (for ssh_key type)',
        },
        fingerprint: {
          type: 'string',
          description: 'SSH key fingerprint (for ssh_key type)',
        },
        totp_secret: {
          type: 'string',
          description: 'TOTP secret key (Base32 encoded, for generic credentials)',
        },
        totp_issuer: {
          type: 'string',
          description: 'TOTP issuer name (e.g. "GitHub")',
        },
        totp_label: {
          type: 'string',
          description: 'TOTP account label (e.g. "user@example.com")',
        },
      },
      required: ['name'],
    },
  };
}

export async function credentialCreate(
  client: ConduitClient,
  args: {
    name: string;
    username?: string;
    password?: string;
    domain?: string;
    private_key?: string;
    tags?: string[];
    credential_type?: string;
    public_key?: string;
    fingerprint?: string;
    totp_secret?: string;
    totp_issuer?: string;
    totp_label?: string;
  },
): Promise<unknown> {
  const credential = await client.credentialCreate(
    args.name,
    args.username ?? null,
    args.password ?? null,
    args.domain ?? null,
    args.private_key ?? null,
    args.tags ?? [],
    args.credential_type ?? null,
    args.public_key ?? null,
    args.fingerprint ?? null,
    args.totp_secret ?? null,
    args.totp_issuer ?? null,
    args.totp_label ?? null,
  );

  return {
    id: credential.id,
    name: credential.name,
    credential_type: credential.credential_type ?? null,
    created_at: credential.created_at,
  };
}

// ---------- credential_read ----------

export function credentialReadDefinition() {
  return {
    name: 'credential_read',
    description:
      'Read a credential without its secret values. You get password_ref (and totp_ref when a one-time password is set up): ' +
      'put that ref in terminal_execute, terminal_send_keys, rdp_type, vnc_type, website_type, website_fill_input or ' +
      'connection_open and Conduit types the real value for you. You never need to see a password to use it. ' +
      'Set reveal: true only when the user truly needs the plain value shown (for example to read it out to them); ' +
      'Conduit then asks the user to Allow or Deny, and the call fails if they deny or do not answer within a minute. ' +
      'has_conflict is true when devices saved different values and the conflict is not resolved yet.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        credential_id: { type: 'string', description: 'UUID of the credential' },
        reveal: {
          type: 'boolean',
          description: 'Ask the user to show the plain password and private key (default false)',
        },
        purpose: {
          type: 'string',
          description: 'Why you need the plain value. Required with reveal; the user reads it before deciding.',
        },
      },
      required: ['credential_id'],
    },
  };
}

export async function credentialRead(
  client: ConduitClient,
  args: { credential_id: string; reveal?: boolean; purpose?: string },
): Promise<unknown> {
  const reveal = args.reveal === true;
  if (reveal && !args.purpose?.trim()) {
    throw new Error('purpose is required with reveal: say why the plain value is needed.');
  }
  const credential = await client.credentialGet(args.credential_id, reveal ? { purpose: args.purpose!.trim() } : undefined);

  return {
    id: credential.id,
    name: credential.name,
    username: credential.username ?? null,
    domain: credential.domain ?? null,
    password_ref: credential.password_ref ?? null,
    totp_ref: credential.totp_ref ?? null,
    has_password: credential.has_password === true,
    has_private_key: credential.has_private_key === true,
    revealed: credential.revealed === true,
    ...(credential.revealed === true ? { password: credential.password ?? null, private_key: credential.private_key ?? null } : {}),
    credential_type: credential.credential_type ?? null,
    public_key: credential.public_key ?? null,
    fingerprint: credential.fingerprint ?? null,
    has_totp: credential.has_totp ?? false,
    totp_issuer: credential.totp_issuer ?? null,
    totp_label: credential.totp_label ?? null,
    totp_algorithm: credential.totp_algorithm ?? null,
    totp_digits: credential.totp_digits ?? null,
    totp_period: credential.totp_period ?? null,
    has_conflict: credential.has_conflict === true,
  };
}

// ---------- credential_delete ----------

export function credentialDeleteDefinition() {
  return {
    name: 'credential_delete',
    description: 'Delete a credential',
    inputSchema: {
      type: 'object' as const,
      properties: {
        credential_id: { type: 'string', description: 'UUID of the credential to delete' },
      },
      required: ['credential_id'],
    },
  };
}

export async function credentialDelete(
  client: ConduitClient,
  args: { credential_id: string },
): Promise<unknown> {
  await client.credentialDelete(args.credential_id);
  return {
    success: true,
    deleted_id: args.credential_id,
  };
}
