/**
 * KB article and embedded-secret records (docs/KNOWLEDGE_BASE.md section 1).
 * The renderer keeps a copy in src/lib/kb-model.ts; both run the same contract vectors.
 */

export const KB_KINDS = ['overview', 'facts', 'procedure', 'troubleshooting', 'contact', 'playbook', 'changelog'] as const;
export type KbKind = (typeof KB_KINDS)[number];
export type KbScope = 'asset' | 'folder' | 'vault';
export type KbStatus = 'active' | 'needs_review' | 'archived';

export interface KbEditorRef {
  kind: 'agent' | 'user';
  name?: string;
  device?: 'desktop' | 'ios';
}

export interface KbMeta {
  v: 1;
  scope: KbScope;
  kind: KbKind;
  summary: string;
  pinned: boolean;
  status: KbStatus;
  author: KbEditorRef;
  last_editor?: KbEditorRef & { at: string };
  verified_at?: string;
  verified_by?: KbEditorRef;
  verify_note?: string;
  reviewed_at?: string;
}

export interface EmbeddedMeta {
  owner_id: string;
  label: string;
  orphaned_at?: string;
  pending_for?: string;
}

export const KB_SUMMARY_MAX = 200;
export const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConfig(config: unknown): Record<string, unknown> | null {
  if (typeof config === 'string') {
    try {
      return parseConfig(JSON.parse(config));
    } catch {
      return null;
    }
  }
  return isPlainObject(config) ? config : null;
}

export function isHiddenConfig(config: unknown): boolean {
  const c = parseConfig(config);
  return !!c && (isPlainObject(c.kb) || isPlainObject(c.embedded));
}

export function isHiddenEntry(entry: { config: unknown }): boolean {
  return isHiddenConfig(entry.config);
}

export function readKb(config: unknown): KbMeta | null {
  const kb = parseConfig(config)?.kb;
  return isPlainObject(kb) ? (kb as unknown as KbMeta) : null;
}

export function readEmbedded(config: unknown): EmbeddedMeta | null {
  const embedded = parseConfig(config)?.embedded;
  return isPlainObject(embedded) ? (embedded as unknown as EmbeddedMeta) : null;
}

export function isKbArticle(entry: { entry_type: string; config: unknown }): boolean {
  return entry.entry_type === 'document' && readKb(entry.config) !== null;
}

export function isEmbeddedSecret(entry: { entry_type: string; config: unknown }): boolean {
  return entry.entry_type === 'credential' && readEmbedded(entry.config) !== null;
}

export function isKbKind(value: unknown): value is KbKind {
  return typeof value === 'string' && (KB_KINDS as readonly string[]).includes(value);
}

export function kindRank(kind: string): number {
  const i = (KB_KINDS as readonly string[]).indexOf(kind);
  return i === -1 ? KB_KINDS.length : i;
}

export function isStale(kb: Partial<KbMeta>, updatedAt: string, now: string): boolean {
  if (kb.kind === 'changelog') return false;
  const since = Date.parse(kb.verified_at ?? updatedAt);
  return Date.parse(now) - since > STALE_AFTER_MS;
}
