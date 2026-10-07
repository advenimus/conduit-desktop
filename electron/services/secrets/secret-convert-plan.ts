/**
 * Plans the conversion of `!!value!!` spans into secret refs (docs/KNOWLEDGE_BASE.md 3.1-3.2).
 * Pure: the caller creates the secrets it returns, then saves the returned text.
 */

import { anyRefRegex, formatSecretRef } from './secret-refs.js';

const SPAN_RE = /!!(.+?)!!/g;
const LABEL_MAX = 40;

export interface PlannedSecret {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface ConversionPlan {
  readonly text: string;
  readonly created: readonly PlannedSecret[];
}

export function hasPlaintextSecrets(text: string | null | undefined): boolean {
  return !!text && new RegExp(SPAN_RE.source).test(text);
}

export function countPlaintextSecrets(text: string | null | undefined): number {
  return text ? [...text.matchAll(SPAN_RE)].length : 0;
}

export function planConversion(text: string, newId: () => string): ConversionPlan {
  const created: PlannedSecret[] = [];
  const byValue = new Map<string, PlannedSecret>();
  let out = '';
  let last = 0;

  for (const m of text.matchAll(SPAN_RE)) {
    const start = m.index ?? 0;
    const value = m[1];
    let secret = byValue.get(value);
    if (!secret) {
      const label = deriveLabel(lineTextBefore(text, start)) || `Secret ${created.length + 1}`;
      secret = { id: newId(), label, value };
      byValue.set(value, secret);
      created.push(secret);
    }
    out += text.slice(last, start) + formatSecretRef(secret.id, secret.label);
    last = start + m[0].length;
  }

  return { text: out + text.slice(last), created };
}

/** The line text before `index`, starting after the last ref or span earlier on that line. */
function lineTextBefore(text: string, index: number): string {
  const line = text.slice(text.lastIndexOf('\n', index - 1) + 1, index);
  let cut = 0;
  for (const re of [anyRefRegex(), new RegExp(SPAN_RE.source, 'g')]) {
    for (const m of line.matchAll(re)) cut = Math.max(cut, (m.index ?? 0) + m[0].length);
  }
  return line.slice(cut);
}

export function deriveLabel(before: string): string {
  let s = before;
  if (s.includes('|')) {
    const cells = s.split('|').filter((cell) => cell.trim() !== '');
    s = cells[cells.length - 1] ?? '';
  }
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^\s*#{1,6}\s+/, '');
  s = s.replace(/[*`{}]/g, '');
  s = s.trim().replace(/[:=\-–—\s]+$/u, '');
  return Array.from(s).slice(0, LABEL_MAX).join('').trim();
}
