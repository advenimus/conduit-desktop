/**
 * Knowledge articles keep their metadata (`config.kb`) and revision list (`config.kb_history`) in
 * their own registers, so one article edited on two devices also conflicts there. Those values are
 * bookkeeping nobody should have to read as JSON, so the app settles them itself and leaves only the
 * article text for the user (docs/KNOWLEDGE_BASE.md 5). The chosen value depends only on the
 * conflicting versions, so devices that resolve at the same time write the same value.
 */

import { appendRevision, readHistory, type KbRevision } from '../knowledge/kb-revisions.js';
import { conflictedRegisters } from './conflicts-shared.js';
import { resolveField } from './conflicts-resolve.js';
import { isEligible } from './sibling.js';
import { TBL } from './types.js';
import type { LocalWrite, SyncContext, SyncState } from './types.js';

export const KB_META_REG = 'config.kb';
export const KB_HISTORY_REG = 'config.kb_history';

type Json = Record<string, unknown>;

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const maxStr = (values: string[]): string | undefined => values.filter(Boolean).sort().pop();

/** The newest edit wins; review and verification keep the latest time any device recorded. */
export function mergeKbMeta(versions: readonly Json[]): Json {
  const ranked = [...versions].sort((a, b) => {
    const at = str((a.last_editor as Json | undefined)?.at).localeCompare(str((b.last_editor as Json | undefined)?.at));
    return at !== 0 ? at : JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
  });
  const winner: Json = { ...ranked[ranked.length - 1] };
  const reviewed = maxStr(versions.map((v) => str(v.reviewed_at)));
  if (reviewed) winner.reviewed_at = reviewed;
  return winner;
}

/** Every revision from every version, oldest first, capped as usual (baseline from the merged review time). */
export function mergeKbHistory(versions: readonly unknown[][], reviewedAt: string | undefined): KbRevision[] {
  const seen = new Map<string, KbRevision>();
  for (const list of versions) {
    for (const rev of readHistory({ kb_history: list })) {
      const key = `${rev.at}\u0000${rev.content}`;
      if (!seen.has(key)) seen.set(key, rev);
    }
  }
  const all = [...seen.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.content < b.content ? -1 : 1));
  return all.reduce<KbRevision[]>((acc, rev) => appendRevision(acc, rev, reviewedAt), []);
}

function eligibleValues(sibs: readonly { flags: number; value: unknown }[]): unknown[] {
  return sibs.filter((s) => isEligible(s as never)).map((s) => parse(s.value));
}

/** Writes that settle every knowledge-metadata conflict in `state`. */
export function knowledgeAutoResolutions(state: SyncState, ctx: SyncContext): LocalWrite[] {
  const writes: LocalWrite[] = [];
  const conflicted = conflictedRegisters(state).filter(
    (c) => c.reg.key.tbl === TBL.entries && (c.reg.key.reg === KB_META_REG || c.reg.key.reg === KB_HISTORY_REG),
  );
  for (const { row, reg } of conflicted) {
    const values = eligibleValues(reg.sibs);
    if (values.length < 2) continue;
    let merged: unknown;
    if (reg.key.reg === KB_META_REG) {
      const metas = values.filter(isObject);
      if (metas.length !== values.length) continue;
      merged = mergeKbMeta(metas);
    } else {
      const lists = values.filter(Array.isArray) as unknown[][];
      if (lists.length !== values.length) continue;
      const metaReg = row.regs.get(KB_META_REG);
      const reviewed = maxStr(eligibleValues(metaReg?.sibs ?? []).filter(isObject).map((m) => str(m.reviewed_at)));
      merged = mergeKbHistory(lists, reviewed);
    }
    writes.push(...resolveField(state, reg.key, { kind: 'value', value: JSON.stringify(merged) }, ctx));
  }
  return writes;
}
