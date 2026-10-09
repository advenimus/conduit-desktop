/**
 * Secret tools: create, rotate and capture secrets inside Conduit so their values never pass
 * through the agent. Every result is a ref to type with, never a value.
 */

import type { ConduitClient } from '../ipc-client.js';

const GENERATE_SCHEMA = {
  type: 'object',
  description: 'Have Conduit generate the value (preferred). Uses letters, digits and shell-safe symbols.',
  properties: {
    length: { type: 'number', description: 'Length, 12 to 128 (default 24)' },
    symbols: { type: 'boolean', description: 'Include shell-safe symbols -_.@%+=:, (default true)' },
  },
};

const SECRET_PARAM = { type: 'string', description: 'The secret: its id or its {{secret:...}} ref' };

// ---------- secret_create ----------

export function secretCreateDefinition() {
  return {
    name: 'secret_create',
    description:
      'Store a new encrypted secret on a vault entry and get back a {{secret:<id>|Label}} ref. ' +
      'Prefer generate, so the value is made inside Conduit and you never see it; then type it with the ref ' +
      '(for example to set a new password) and write the ref into the entry notes or a knowledge article so the user and ' +
      'future sessions can find it. Use value only for something the user gave you.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner_id: { type: 'string', description: 'Entry the secret belongs to (asset, article or document id)' },
        label: { type: 'string', description: 'Short label shown on the chip, e.g. "Local admin"' },
        generate: GENERATE_SCHEMA,
        value: { type: 'string', description: 'The value, when you already have it (avoid when possible)' },
      },
      required: ['owner_id', 'label'],
    },
  };
}

export async function secretCreate(
  client: ConduitClient,
  args: { owner_id: string; label: string; generate?: Record<string, unknown> | boolean; value?: string },
): Promise<unknown> {
  return client.secretRequest('SecretCreate', args);
}

// ---------- secret_rotate / commit / discard ----------

export function secretRotateDefinition() {
  return {
    name: 'secret_rotate',
    description:
      'Stage a new value for a secret or credential without replacing the current one yet. Returns pending_ref ' +
      '({{secret:<id>.pending}}): type it where the new password goes (for example passwd or a web form) while the ' +
      'old value still works through the normal ref. When the system accepts it, call secret_commit; if it fails, ' +
      'call secret_discard. Committing keeps the old value in password history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        secret: SECRET_PARAM,
        generate: GENERATE_SCHEMA,
        value: { type: 'string', description: 'The new value, when you already have it (avoid when possible)' },
      },
      required: ['secret'],
    },
  };
}

export async function secretRotate(client: ConduitClient, args: { secret: string; generate?: unknown; value?: string }): Promise<unknown> {
  return client.secretRequest('SecretRotate', { ...args, generate: args.value === undefined ? (args.generate ?? true) : args.generate });
}

export function secretCommitDefinition() {
  return {
    name: 'secret_commit',
    description: 'Make the staged value from secret_rotate the secret\'s current value. The old value moves to password history.',
    inputSchema: { type: 'object' as const, properties: { secret: SECRET_PARAM }, required: ['secret'] },
  };
}

export async function secretCommit(client: ConduitClient, args: { secret: string }): Promise<unknown> {
  return client.secretRequest('SecretCommit', args);
}

export function secretDiscardDefinition() {
  return {
    name: 'secret_discard',
    description: 'Throw away the staged value from secret_rotate and keep the current one.',
    inputSchema: { type: 'object' as const, properties: { secret: SECRET_PARAM }, required: ['secret'] },
  };
}

export async function secretDiscard(client: ConduitClient, args: { secret: string }): Promise<unknown> {
  return client.secretRequest('SecretDiscard', args);
}

// ---------- secret_capture ----------

export function secretCaptureDefinition() {
  return {
    name: 'secret_capture',
    description:
      'Save a value that appears in a session straight into a new encrypted secret, without it being returned to you: ' +
      'an API key a console just printed, a generated token on a web page. For a terminal give pattern (a regular ' +
      'expression; its first group, or the whole match, is captured from the visible screen). For a web page give the ' +
      'CSS selector of the input or element. Returns a {{secret:<id>|Label}} ref.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'Session to capture from (terminal or web session id)' },
        owner_id: { type: 'string', description: 'Entry the new secret belongs to' },
        label: { type: 'string', description: 'Short label shown on the chip' },
        pattern: { type: 'string', description: 'Terminal: regular expression to find the value' },
        selector: { type: 'string', description: 'Web: CSS selector of the element holding the value' },
      },
      required: ['connection_id', 'owner_id', 'label'],
    },
  };
}

export async function secretCapture(
  client: ConduitClient,
  args: { connection_id: string; owner_id: string; label: string; pattern?: string; selector?: string },
): Promise<unknown> {
  return client.secretRequest('SecretCapture', args);
}

// ---------- secret_reveal ----------

export function secretRevealDefinition() {
  return {
    name: 'secret_reveal',
    description:
      'Ask the user to show you a secret\'s plain value. Conduit shows a dialog with your purpose; the call fails ' +
      'with APPROVAL_DENIED if they deny or do not answer within a minute. Only use this when the value itself must ' +
      'be shown to the user. To type a secret, use its ref instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        secret: SECRET_PARAM,
        purpose: { type: 'string', description: 'Why the plain value is needed; the user reads it before deciding' },
      },
      required: ['secret', 'purpose'],
    },
  };
}

export async function secretReveal(client: ConduitClient, args: { secret: string; purpose: string }): Promise<unknown> {
  if (!args.purpose?.trim()) throw new Error('purpose is required: say why the plain value is needed.');
  const id = secretId(args.secret);
  const result = await client.credentialGet(id, { purpose: args.purpose.trim() });
  return { id, name: result.name, value: result.password ?? null, revealed: result.revealed === true };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function secretId(value: string): string {
  const match = typeof value === 'string' ? UUID_RE.exec(value) : null;
  if (!match) throw new Error('secret must be an id or a {{secret:...}} ref');
  return match[0].toLowerCase();
}
