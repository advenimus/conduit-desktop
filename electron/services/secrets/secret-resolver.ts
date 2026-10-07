/**
 * Turns secret and credential refs into real values, in the main process only
 * (docs/KNOWLEDGE_BASE.md 2.2). Agents send refs; these values never go back to them.
 */

import { TOTP } from 'otpauth';
import { readEmbedded } from '../knowledge/kb-model.js';
import { parseRefs, type ParsedRef } from './secret-refs.js';

export interface ResolverCredential {
  id: string;
  name: string;
  username: string | null;
  password: string | null;
  totp_secret: string | null;
  totp_algorithm: string | null;
  totp_digits: number | null;
  totp_period: number | null;
}

/** The slice of ConduitVault the resolver reads. */
export interface ResolverVault {
  getCredential(id: string): ResolverCredential;
  listEntries(): Array<{ id: string; entry_type: string; config: unknown }>;
}

export class SecretRefError extends Error {
  readonly code = 'SECRET_REF_ERROR';
}

export interface UsedSecret {
  id: string;
  label: string;
  value: string;
}

export interface Substitution {
  text: string;
  used: UsedSecret[];
}

function lookup(vault: ResolverVault, id: string): ResolverCredential {
  try {
    return vault.getCredential(id);
  } catch {
    throw new SecretRefError(`No secret or credential with id ${id} in this vault. Read the entry again for current refs.`);
  }
}

function pendingFor(vault: ResolverVault, id: string): string {
  const pending = vault.listEntries().find((e) => e.entry_type === 'credential' && readEmbedded(e.config)?.pending_for === id);
  if (!pending) throw new SecretRefError(`Secret ${id} has no staged rotation. Call secret_rotate first.`);
  return pending.id;
}

export function currentTotp(cred: ResolverCredential, now = Date.now()): string {
  if (!cred.totp_secret) throw new SecretRefError(`${cred.name} has no one-time password set up.`);
  const totp = new TOTP({
    secret: cred.totp_secret,
    algorithm: cred.totp_algorithm ?? 'SHA1',
    digits: cred.totp_digits ?? 6,
    period: cred.totp_period ?? 30,
  });
  return totp.generate({ timestamp: now });
}

export function resolveRef(vault: ResolverVault, ref: ParsedRef): UsedSecret {
  const id = ref.kind === 'secret' && ref.pending ? pendingFor(vault, ref.id) : ref.id;
  const cred = lookup(vault, id);
  const field = ref.field ?? 'password';
  let value: string | null;
  if (field === 'totp') value = currentTotp(cred);
  else if (field === 'username') value = cred.username;
  else value = cred.password;
  if (!value) throw new SecretRefError(`${cred.name} has no ${field === 'password' ? 'value' : field} to use.`);
  return { id: ref.id, label: cred.name, value };
}

/** Replaces every ref in `text` with its value. Throws on any ref that can't be resolved. */
export function substituteRefs(vault: ResolverVault, text: string): Substitution {
  const refs = parseRefs(text);
  if (refs.length === 0) return { text, used: [] };
  const used: UsedSecret[] = [];
  let out = '';
  let last = 0;
  for (const ref of refs) {
    const secret = resolveRef(vault, ref);
    used.push(secret);
    out += text.slice(last, ref.start) + secret.value;
    last = ref.end;
  }
  return { text: out + text.slice(last), used };
}
