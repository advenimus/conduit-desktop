/** Article revision history (docs/KNOWLEDGE_BASE.md section 5). */

import type { KbEditorRef } from './kb-model.js';

export type KbEditor = KbEditorRef;

export interface KbRevision {
  at: string;
  author: KbEditor;
  reason?: string;
  content: string;
}

export const KB_HISTORY_CAP = 20;
export const UNDO_REASON = 'Undo agent edits';

/** reviewed_at set: newest revision at or before it. Otherwise the newest user revision. */
export function baselineRevision(history: readonly KbRevision[], reviewedAt: string | undefined): KbRevision | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const rev = history[i];
    if (reviewedAt !== undefined ? rev.at <= reviewedAt : rev.author.kind === 'user') return rev;
  }
  return null;
}

/** Appends a revision, keeping the newest KB_HISTORY_CAP plus the baseline if it would drop off. */
export function appendRevision(history: readonly KbRevision[], rev: KbRevision, reviewedAt: string | undefined): KbRevision[] {
  const next = [...history, rev];
  if (next.length <= KB_HISTORY_CAP) return next;
  const kept = next.slice(next.length - KB_HISTORY_CAP);
  const baseline = baselineRevision(next, reviewedAt);
  return baseline && !kept.includes(baseline) ? [baseline, ...kept] : kept;
}

export function hasUnseenAgentEdit(kb: { last_editor?: { kind: string; at: string }; reviewed_at?: string }): boolean {
  const editor = kb.last_editor;
  if (!editor || editor.kind !== 'agent') return false;
  return kb.reviewed_at === undefined || kb.reviewed_at < editor.at;
}

export function readHistory(config: Record<string, unknown>): KbRevision[] {
  const raw = config.kb_history;
  return Array.isArray(raw) ? (raw.filter((r) => r && typeof r === 'object' && typeof r.content === 'string') as KbRevision[]) : [];
}
