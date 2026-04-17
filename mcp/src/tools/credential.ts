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
    description: 'Retrieve a credential including secrets. REQUIRES USER APPROVAL.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        credential_id: { type: 'string', description: 'UUID of the credential' },
        purpose: {
          type: 'string',
          description: 'Explanation for why the credential is needed (for user approval)',
        },
      },
      required: ['credential_id', 'purpose'],
    },
  };
}

export async function credentialRead(
  client: ConduitClient,
  args: { credential_id: string; purpose: string },
  approvalGranted = false,
): Promise<unknown> {
  // Primary gate is in index.ts (ToolApprovalService). This is defense-in-depth:
  // if this function is ever called outside the gate, block it.
  if (!approvalGranted) {
    throw new Error('credential_read requires approval — must be called through the approval gate');
  }
  const credential = await client.credentialGet(args.credential_id);

  return {
    id: credential.id,
    name: credential.name,
    username: credential.username ?? null,
    password: credential.password ?? null,
    domain: credential.domain ?? null,
    private_key: credential.private_key ?? null,
    credential_type: credential.credential_type ?? null,
    public_key: credential.public_key ?? null,
    fingerprint: credential.fingerprint ?? null,
    has_totp: credential.has_totp ?? false,
    totp_issuer: credential.totp_issuer ?? null,
    totp_label: credential.totp_label ?? null,
    totp_algorithm: credential.totp_algorithm ?? null,
    totp_digits: credential.totp_digits ?? null,
    totp_period: credential.totp_period ?? null,
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
