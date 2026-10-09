/** Notes migration helpers (docs/KNOWLEDGE_BASE.md section 7). */

import type { KbKind } from './kb-model.js';

export type MigrationReason = 'long' | 'headings' | 'steps';

export const MIGRATION_MIN_LENGTH = 400;
export const MIGRATION_POINTER = 'Moved to Knowledge. See the Knowledge tab.';

export function migrationSuggestion(notes: string | null | undefined, assetArticleCount: number, dismissed: boolean): MigrationReason | null {
  if (!notes || assetArticleCount > 0 || dismissed) return null;
  if (notes.trim().length >= MIGRATION_MIN_LENGTH) return 'long';
  if (/^#{1,6}\s/m.test(notes)) return 'headings';
  if ((notes.match(/^\s*\d+[.)]\s/gm) ?? []).length >= 3) return 'steps';
  return null;
}

export interface SplitArticle {
  title: string;
  kind: KbKind;
  pinned: boolean;
  body: string;
}

const KIND_WORDS: ReadonlyArray<[KbKind, readonly string[]]> = [
  ['overview', ['overview', 'summary', 'about']],
  ['contact', ['contact', 'contacts', 'vendor', 'support', 'phone', 'email']],
  ['troubleshooting', ['issue', 'issues', 'error', 'errors', 'troubleshoot', 'troubleshooting', 'problem', 'problems', 'fix', 'known']],
  ['procedure', ['steps', 'procedure', 'procedures', 'how', 'reboot', 'restart', 'install', 'update', 'upgrade', 'backup', 'restore']],
];

export function kindForTitle(title: string): KbKind {
  const words = new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  for (const [kind, list] of KIND_WORDS) {
    if (list.some((w) => words.has(w))) return kind;
  }
  return 'facts';
}

const HEADING_SECRET_RE = /!!(.+?)!!|\{\{(?:secret|cred):[^}\n]*\}\}/g;

function headingParts(heading: string): { title: string; secrets: string[] } {
  const secrets = heading.match(HEADING_SECRET_RE) ?? [];
  return { title: heading.replace(HEADING_SECRET_RE, '••••').trim(), secrets };
}

function trimBlankLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end).join('\n');
}

/** Line indexes of headings at `level`, ignoring lines inside fenced code blocks. */
function headingLines(lines: string[], level: 1 | 2): number[] {
  const marker = level === 1 ? /^# (.*)$/ : /^## (.*)$/;
  const found: number[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && marker.test(line)) found.push(i);
  });
  return found;
}

export function splitNotes(notes: string): SplitArticle[] {
  const lines = notes.replace(/\r\n/g, '\n').split('\n');
  let heads = headingLines(lines, 2);
  let prefix = 3;
  if (heads.length === 0) {
    heads = headingLines(lines, 1);
    prefix = 2;
  }

  const sections: Array<{ title: string; body: string }> = [];
  const intro = trimBlankLines(lines.slice(0, heads.length ? heads[0] : lines.length));
  if (intro.trim()) sections.push({ title: 'Overview', body: intro });
  heads.forEach((lineIndex, i) => {
    const { title, secrets } = headingParts(lines[lineIndex].slice(prefix));
    const rest = trimBlankLines(lines.slice(lineIndex + 1, heads[i + 1] ?? lines.length));
    // A secret in a heading would be lost in the plain-text title, so it moves to the top of the body.
    const body = secrets.length ? [secrets.join(' '), rest].filter(Boolean).join('\n') : rest;
    if (body.trim()) sections.push({ title, body });
  });

  let pinned = false;
  return sections.map(({ title, body }) => {
    const kind = kindForTitle(title);
    const pin = kind === 'overview' && !pinned;
    if (pin) pinned = true;
    return { title, kind, pinned: pin, body };
  });
}
