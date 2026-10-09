// @vitest-environment node
// Runs the KB contract vectors (docs/KNOWLEDGE_BASE.md). The iOS app runs the same files, so a
// failure here means desktop drifted from the contract, not that the vectors need updating.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRefs } from '../../secrets/secret-refs.js';
import { planConversion } from '../../secrets/secret-convert-plan.js';
import { isHiddenConfig, isStale, type KbMeta } from '../kb-model.js';
import { migrationSuggestion, splitNotes } from '../notes-split.js';
import { knowledgeFor, type KbEntryLike, type KbFolderLike } from '../kb-inherit.js';
import { appendRevision, baselineRevision, hasUnseenAgentEdit, type KbRevision, type KbEditor } from '../kb-revisions.js';
import { formatChangelogLine, insertChangelogLine } from '../changelog.js';
import { mergeKbHistory, mergeKbMeta } from '../../sync/kb-auto-resolve.js';

const VECTORS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__vectors__');

interface VectorCase {
  name: string;
  fn: string;
  input: unknown;
  expect: unknown;
}

function cases(file: string): VectorCase[] {
  return (JSON.parse(fs.readFileSync(path.join(VECTORS, file), 'utf-8')) as { cases: VectorCase[] }).cases;
}

function run(file: string, call: (c: VectorCase) => unknown): void {
  describe(file, () => {
    for (const c of cases(file)) {
      it(c.name, () => expect(call(c)).toEqual(c.expect));
    }
  });
}

run('refs.json', (c) =>
  parseRefs(c.input as string).map(({ kind, id, pending, label, field }) => ({ kind, id, pending, label, field })),
);

run('convert.json', (c) => {
  const { text, ids } = c.input as { text: string; ids: string[] };
  const queue = [...ids];
  return planConversion(text, () => {
    const id = queue.shift();
    if (!id) throw new Error('vector ran out of ids');
    return id;
  });
});

run('hidden.json', (c) => isHiddenConfig(c.input));

run('stale.json', (c) => {
  const { kb, updated_at, now } = c.input as { kb: Partial<KbMeta>; updated_at: string; now: string };
  return isStale(kb, updated_at, now);
});

run('migration.json', (c) => {
  const { notes, asset_article_count, dismissed } = c.input as { notes: string | null; asset_article_count: number; dismissed: boolean };
  return migrationSuggestion(notes, asset_article_count, dismissed);
});

run('split.json', (c) => splitNotes(c.input as string));

run('inherit.json', (c) => {
  const { target, entries, folders } = c.input as {
    target: { entry_id: string } | { folder_id: string };
    entries: KbEntryLike[];
    folders: KbFolderLike[];
  };
  return knowledgeFor(target, entries, folders).map(({ entry, group }) => ({ id: entry.id, group }));
});

type Step =
  | { op: 'save'; at: string; author: KbEditor; content: string }
  | { op: 'keep' }
  | { op: 'undo'; at: string };

run('revisions.json', (c) => {
  let history: KbRevision[] = [];
  let lastEditor: (KbEditor & { at: string }) | undefined;
  let reviewedAt: string | undefined;
  const snapshot = () => {
    const baseline = baselineRevision(history, reviewedAt);
    return {
      count: history.length,
      latest_content: history[history.length - 1]?.content,
      unseen: hasUnseenAgentEdit({ last_editor: lastEditor, reviewed_at: reviewedAt }),
      baseline_content: baseline ? baseline.content : null,
    };
  };
  return (c.input as Step[]).map((step) => {
    if (step.op === 'save') {
      history = appendRevision(history, { at: step.at, author: step.author, content: step.content }, reviewedAt);
      lastEditor = { ...step.author, at: step.at };
    } else if (step.op === 'keep') {
      reviewedAt = history[history.length - 1]?.at;
    } else {
      const baseline = baselineRevision(history, reviewedAt);
      if (!baseline) return { error: 'no_baseline' };
      const author: KbEditor = { kind: 'user' };
      history = appendRevision(history, { at: step.at, author, reason: 'Undo agent edits', content: baseline.content }, step.at);
      lastEditor = { ...author, at: step.at };
      reviewedAt = step.at;
    }
    return snapshot();
  });
});

run('changelog.json', (c) => {
  if (c.fn === 'formatLine') {
    const { at, name, text } = c.input as { at: string; name: string | null; text: string };
    return formatChangelogLine(at, name, text);
  }
  const { content, line } = c.input as { content: string; line: string };
  return insertChangelogLine(content, line);
});

run('autoresolve.json', (c) => {
  if (c.fn === 'mergeKbMeta') return mergeKbMeta(c.input as Record<string, unknown>[]);
  const { versions, reviewed_at } = c.input as { versions: unknown[][]; reviewed_at: string | null };
  return mergeKbHistory(versions, reviewed_at ?? undefined);
});
