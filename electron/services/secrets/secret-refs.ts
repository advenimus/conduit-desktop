/**
 * Secret and credential references (docs/KNOWLEDGE_BASE.md section 2).
 *
 *   {{secret:<uuid>[.pending][|<label>]}}
 *   {{cred:<uuid>[.username|.password|.totp]}}
 */

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SECRET_SRC = `\\{\\{secret:(${UUID})(\\.pending)?(?:\\|([^}|\\n]{0,80}))?\\}\\}`;
const CRED_SRC = `\\{\\{cred:(${UUID})(?:\\.(username|password|totp))?\\}\\}`;

export const SECRET_LABEL_MAX = 80;

export type CredField = 'username' | 'password' | 'totp';

export interface ParsedRef {
  readonly kind: 'secret' | 'cred';
  readonly id: string;
  readonly pending: boolean;
  readonly label: string | null;
  /** null for secret refs. */
  readonly field: CredField | null;
  readonly start: number;
  readonly end: number;
  readonly raw: string;
}

/** A fresh global regex matching either ref form (group 1-3 secret, 4-5 cred). */
export function anyRefRegex(): RegExp {
  return new RegExp(`${SECRET_SRC}|${CRED_SRC}`, 'g');
}

export function parseRefs(text: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  for (const m of text.matchAll(anyRefRegex())) {
    const start = m.index ?? 0;
    const base = { start, end: start + m[0].length, raw: m[0] };
    if (m[1] !== undefined) {
      refs.push({ ...base, kind: 'secret', id: m[1].toLowerCase(), pending: m[2] !== undefined, label: m[3] ? m[3] : null, field: null });
    } else {
      refs.push({ ...base, kind: 'cred', id: m[4].toLowerCase(), pending: false, label: null, field: (m[5] as CredField | undefined) ?? 'password' });
    }
  }
  return refs;
}

export function hasRefs(text: string): boolean {
  return anyRefRegex().test(text);
}

/** Ids of every {{secret:...}} ref in the text (lower-case, no duplicates). */
export function referencedSecretIds(text: string): Set<string> {
  return new Set(parseRefs(text).filter((r) => r.kind === 'secret').map((r) => r.id));
}

export function formatSecretRef(id: string, label: string | null): string {
  const clean = label ? sanitizeLabel(label) : '';
  return clean ? `{{secret:${id}|${clean}}}` : `{{secret:${id}}}`;
}

/**
 * Strips characters a label can't hold and cuts it to the ref's limit. The limit counts UTF-16 code
 * units, like the ref regex, and never splits a surrogate pair.
 */
export function sanitizeLabel(label: string): string {
  let out = '';
  for (const ch of label.replace(/[{}|\r\n]/g, ' ').trim()) {
    if (out.length + ch.length > SECRET_LABEL_MAX) break;
    out += ch;
  }
  return out.trim();
}
