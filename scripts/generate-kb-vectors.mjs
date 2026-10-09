// Writes the knowledge base contract vectors (docs/KNOWLEDGE_BASE.md) into
// electron/services/knowledge/__vectors__. Expectations are written by hand here; only long inputs are
// built in code. The iOS app copies the output with its scripts/kb-vectors.sh.
// Usage: node scripts/generate-kb-vectors.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'services', 'knowledge', '__vectors__');
fs.mkdirSync(out, { recursive: true });
const write = (name, module, notes, cases) =>
  fs.writeFileSync(path.join(out, name), JSON.stringify({ format: 1, module, notes, cases }, null, 2) + '\n');

const A = '11111111-2222-4333-8444-555555555555';
const B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const C = 'cccccccc-0000-4000-8000-000000000001';

// ---- refs
write('refs.json', 'refs', [
  'parseRefs(text) lists refs in order of appearance. See docs/KNOWLEDGE_BASE.md section 2.1.',
  'ids are lower-cased; an empty label is null; a cred ref with no field has field "password"; secret refs have field null.',
], [
  { name: 'secret with label', fn: 'parseRefs', input: `pw {{secret:${A}|Local admin}} end`, expect: [{ kind: 'secret', id: A, pending: false, label: 'Local admin', field: null }] },
  { name: 'secret without label', fn: 'parseRefs', input: `{{secret:${A}}}`, expect: [{ kind: 'secret', id: A, pending: false, label: null, field: null }] },
  { name: 'empty label is null', fn: 'parseRefs', input: `{{secret:${A}|}}`, expect: [{ kind: 'secret', id: A, pending: false, label: null, field: null }] },
  { name: 'pending', fn: 'parseRefs', input: `{{secret:${A}.pending|New pw}}`, expect: [{ kind: 'secret', id: A, pending: true, label: 'New pw', field: null }] },
  { name: 'upper-case id is lower-cased', fn: 'parseRefs', input: `{{secret:${B.toUpperCase()}|X}}`, expect: [{ kind: 'secret', id: B, pending: false, label: 'X', field: null }] },
  { name: 'short id is not a ref', fn: 'parseRefs', input: '{{secret:1234|x}}', expect: [] },
  { name: 'second pipe is not a ref', fn: 'parseRefs', input: `{{secret:${A}|a|b}}`, expect: [] },
  { name: 'label over 80 chars is not a ref', fn: 'parseRefs', input: `{{secret:${A}|${'x'.repeat(81)}}}`, expect: [] },
  { name: 'label of exactly 80 chars', fn: 'parseRefs', input: `{{secret:${A}|${'x'.repeat(80)}}}`, expect: [{ kind: 'secret', id: A, pending: false, label: 'x'.repeat(80), field: null }] },
  { name: 'line break in label is not a ref', fn: 'parseRefs', input: `{{secret:${A}|a\nb}}`, expect: [] },
  { name: 'cred default field', fn: 'parseRefs', input: `{{cred:${B}}}`, expect: [{ kind: 'cred', id: B, pending: false, label: null, field: 'password' }] },
  { name: 'cred totp and username', fn: 'parseRefs', input: `u={{cred:${B}.username}} c={{cred:${B}.totp}}`, expect: [
    { kind: 'cred', id: B, pending: false, label: null, field: 'username' },
    { kind: 'cred', id: B, pending: false, label: null, field: 'totp' },
  ] },
  { name: 'cred unknown field is not a ref', fn: 'parseRefs', input: `{{cred:${B}.private_key}}`, expect: [] },
  { name: 'label of 80 UTF-16 units with emoji', fn: 'parseRefs', input: `{{secret:${A}|${'\u{1F511}'.repeat(40)}}}`, expect: [{ kind: 'secret', id: A, pending: false, label: '\u{1F511}'.repeat(40), field: null }] },
  { name: 'label over 80 UTF-16 units with emoji is not a ref', fn: 'parseRefs', input: `{{secret:${A}|${'\u{1F511}'.repeat(41)}}}`, expect: [] },
  { name: 'mixed order', fn: 'parseRefs', input: `{{cred:${B}}} then {{secret:${A}|a}}`, expect: [
    { kind: 'cred', id: B, pending: false, label: null, field: 'password' },
    { kind: 'secret', id: A, pending: false, label: 'a', field: null },
  ] },
]);

// ---- convert
const conv = (name, text, ids, expectText, created) => ({ name, fn: 'convert', input: { text, ids }, expect: { text: expectText, created } });
const ref = (id, label) => `{{secret:${id}|${label}}}`;
write('convert.json', 'convert', [
  'convert(text, ids) replaces each !!value!! span with a secret ref (sections 3.1 and 3.2).',
  'ids are the UUIDs to hand out, in order of first appearance of each distinct value. created lists the new secrets in that order.',
], [
  conv('simple label', 'Admin pw: !!hunter2!!', [A], `Admin pw: ${ref(A, 'Admin pw')}`, [{ id: A, label: 'Admin pw', value: 'hunter2' }]),
  conv('list marker and bold', '- **Root**: !!s3cret!!', [A], `- **Root**: ${ref(A, 'Root')}`, [{ id: A, label: 'Root', value: 's3cret' }]),
  conv('numbered list', '  2) Wifi key = !!abc 123!!', [A], `  2) Wifi key = ${ref(A, 'Wifi key')}`, [{ id: A, label: 'Wifi key', value: 'abc 123' }]),
  conv('heading', '## Wifi !!key!!', [A], `## Wifi ${ref(A, 'Wifi')}`, [{ id: A, label: 'Wifi', value: 'key' }]),
  conv('table cell gets no label', '| DB | !!pw1!! |', [A], `| DB | {{secret:${A}}} |`, [{ id: A, label: 'DB', value: 'pw1' }]),
  conv('table cell with label text', '  | Name | Admin pw: !!x!! |', [A], `  | Name | Admin pw: {{secret:${A}}} |`, [{ id: A, label: 'Admin pw', value: 'x' }]),
  conv('same value in a table and a line', 'Root: !!pw!!\n| copy | !!pw!! |', [A], `Root: ${ref(A, 'Root')}\n| copy | {{secret:${A}}} |`, [{ id: A, label: 'Root', value: 'pw' }]),
  conv('two on one line', 'user: !!bob!! pass: !!pw!!', [A, B], `user: ${ref(A, 'user')} pass: ${ref(B, 'pass')}`, [
    { id: A, label: 'user', value: 'bob' }, { id: B, label: 'pass', value: 'pw' },
  ]),
  conv('no text before', '!!x!!', [A], ref(A, 'Secret 1'), [{ id: A, label: 'Secret 1', value: 'x' }]),
  conv('secret number counts created secrets', 'user: !!a!!\n!!b!!', [A, B], `user: ${ref(A, 'user')}\n${ref(B, 'Secret 2')}`, [
    { id: A, label: 'user', value: 'a' }, { id: B, label: 'Secret 2', value: 'b' },
  ]),
  conv('duplicate values share one secret', 'a: !!same!! b: !!same!!', [A], `a: ${ref(A, 'a')} b: ${ref(A, 'a')}`, [{ id: A, label: 'a', value: 'same' }]),
  conv('after an existing ref', `a {{secret:${C}|a}} b: !!x!!`, [A], `a {{secret:${C}|a}} b: ${ref(A, 'b')}`, [{ id: A, label: 'b', value: 'x' }]),
  conv('multi-line', 'Line one\nKey = !!abc!!\n', [A], `Line one\nKey = ${ref(A, 'Key')}\n`, [{ id: A, label: 'Key', value: 'abc' }]),
  conv('label cut to 40 code points', 'This is a very long description of the secret value here: !!v!!', [A],
    `This is a very long description of the secret value here: ${ref(A, 'This is a very long description of the s')}`,
    [{ id: A, label: 'This is a very long description of the s', value: 'v' }]),
  conv('cut then trimmed', 'This is a very long description of the  secret: !!v!!', [A],
    `This is a very long description of the  secret: ${ref(A, 'This is a very long description of the')}`,
    [{ id: A, label: 'This is a very long description of the', value: 'v' }]),
  conv('backticks removed, underscores kept', '`db_admin` token: !!t!!', [A], `\`db_admin\` token: ${ref(A, 'db_admin token')}`, [{ id: A, label: 'db_admin token', value: 't' }]),
  conv('braces removed', 'x} y{ !!v!!', [A], `x} y{ ${ref(A, 'x y')}`, [{ id: A, label: 'x y', value: 'v' }]),
  conv('trailing dash and em dash', 'Key — !!v!!', [A], `Key — ${ref(A, 'Key')}`, [{ id: A, label: 'Key', value: 'v' }]),
  conv('nothing to convert', `see {{secret:${C}|a}}`, [], `see {{secret:${C}|a}}`, []),
  conv('in a code block', '```\nexport PW=!!x!!\n```', [A], `\`\`\`\nexport PW=${ref(A, 'export PW')}\n\`\`\``, [{ id: A, label: 'export PW', value: 'x' }]),
]);

// ---- hidden
const hid = (name, config, expect) => ({ name, fn: 'isHidden', input: config, expect });
write('hidden.json', 'hidden', [
  'isHidden(config): config is a parsed JSON value or a raw JSON string (iOS stores it as text). Section 1.3.',
], [
  hid('empty object', {}, false),
  hid('kb object', { kb: { v: 1 } }, true),
  hid('embedded object', { embedded: { owner_id: A } }, true),
  hid('kb null', { kb: null }, false),
  hid('kb string', { kb: 'x' }, false),
  hid('kb array', { kb: [] }, false),
  hid('document content only', { content: '# hi' }, false),
  hid('raw string with kb', '{"kb":{}}', true),
  hid('raw string without kb', '{"content":"x"}', false),
  hid('invalid json string', 'not json', false),
  hid('top-level array', [], false),
  hid('null config', null, false),
]);

// ---- stale
const DAY = 86400000;
const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const st = (name, kb, updated_at, expect) => ({ name, fn: 'isStale', input: { kb, updated_at, now: new Date(NOW).toISOString() }, expect });
write('stale.json', 'stale', ['isStale(kb, updated_at, now). Section 6. Exactly 90 days is not stale.'], [
  st('verified 91 days ago', { kind: 'facts', verified_at: ago(91) }, ago(1), true),
  st('verified 89 days ago', { kind: 'facts', verified_at: ago(89) }, ago(200), false),
  st('exactly 90 days', { kind: 'facts', verified_at: ago(90) }, ago(200), false),
  st('never verified, updated 100 days ago', { kind: 'procedure' }, ago(100), true),
  st('never verified, updated 10 days ago', { kind: 'procedure' }, ago(10), false),
  st('changelog never stale', { kind: 'changelog' }, ago(400), false),
]);

// ---- migration
const mig = (name, notes, asset_article_count, dismissed, expect) => ({ name, fn: 'migrationSuggestion', input: { notes, asset_article_count, dismissed }, expect });
write('migration.json', 'migration', ['migrationSuggestion(notes, asset_article_count, dismissed) returns a reason or null. Section 7.1.'], [
  mig('no notes', null, 0, false, null),
  mig('short', 'abc', 0, false, null),
  mig('400 chars', 'a'.repeat(400), 0, false, 'long'),
  mig('399 chars', 'a'.repeat(399), 0, false, null),
  mig('padding does not count', '   ' + 'a'.repeat(398) + '   ', 0, false, null),
  mig('heading', '# Title\nshort', 0, false, 'headings'),
  mig('heading not on first line', 'intro\n### Steps', 0, false, 'headings'),
  mig('hashtag is not a heading', '#hashtag', 0, false, null),
  mig('three numbered lines', '1. a\n2. b\n 3) c', 0, false, 'steps'),
  mig('two numbered lines', '1. a\n2. b', 0, false, null),
  mig('long wins over headings', '# T\n' + 'a'.repeat(400), 0, false, 'long'),
  mig('has articles', 'a'.repeat(500), 1, false, null),
  mig('dismissed', 'a'.repeat(500), 0, true, null),
]);

// ---- split
const art = (title, kind, pinned, body) => ({ title, kind, pinned, body });
const sp = (name, notes, expect) => ({ name, fn: 'splitNotes', input: notes, expect });
write('split.json', 'split', ['splitNotes(notes) returns articles in order. Section 7.2.'], [
  sp('intro and sections', 'Intro text\n\n## Reboot procedure\n1. step\n2. step\n\n## Known issues\nDisk fills\n', [
    art('Overview', 'overview', true, 'Intro text'),
    art('Reboot procedure', 'procedure', false, '1. step\n2. step'),
    art('Known issues', 'troubleshooting', false, 'Disk fills'),
  ]),
  sp('no headings', 'Just some text\n', [art('Overview', 'overview', true, 'Just some text')]),
  sp('level-1 only', '# Network\nIP 10.0.0.1\n# Contacts\nBob', [
    art('Network', 'facts', false, 'IP 10.0.0.1'),
    art('Contacts', 'contact', false, 'Bob'),
  ]),
  sp('level-2 wins over level-1', '# Server\n## Specs\n8GB\n## How to restart\nrun x', [
    art('Overview', 'overview', true, '# Server'),
    art('Specs', 'facts', false, '8GB'),
    art('How to restart', 'procedure', false, 'run x'),
  ]),
  sp('heading inside code fence', '## Setup\n```\n## not a heading\n```\nend', [
    art('Setup', 'facts', false, '```\n## not a heading\n```\nend'),
  ]),
  sp('blank section dropped', '## Empty\n\n## Next\nx', [art('Next', 'facts', false, 'x')]),
  sp('whole words only', '## Fixtures list\na\n## How-to: restart\nb', [
    art('Fixtures list', 'facts', false, 'a'),
    art('How-to: restart', 'procedure', false, 'b'),
  ]),
  sp('explicit overview heading is pinned', '## Overview\nabc\n## Wifi\nkey', [
    art('Overview', 'overview', true, 'abc'),
    art('Wifi', 'facts', false, 'key'),
  ]),
  sp('only first overview pinned', 'pre\n## Summary\nabc', [
    art('Overview', 'overview', true, 'pre'),
    art('Summary', 'overview', false, 'abc'),
  ]),
  sp('contact checked before troubleshooting', '## Vendor issues\nx', [art('Vendor issues', 'contact', false, 'x')]),
  sp('crlf', 'a\r\n## B\r\nc\r\n', [art('Overview', 'overview', true, 'a'), art('B', 'facts', false, 'c')]),
  sp('empty notes', '   \n', []),
  sp('secret in a heading moves to the body', '## Wifi !!key-1!!\nSSID home', [art('Wifi ••••', 'facts', false, '!!key-1!!\nSSID home')]),
  sp('ref in a heading with no body', `## Router {{secret:${A}|admin}}`, [art('Router ••••', 'facts', false, `{{secret:${A}|admin}}`)]),
]);

// ---- inherit
const kb = (scope, kind, extra = {}) => ({ kb: { v: 1, scope, kind, summary: '', pinned: false, status: 'active', ...extra } });
const e = (id, name, { folder_id = null, parent_entry_id = null, tags = [], config = {}, entry_type = 'document' } = {}) =>
  ({ id, name, entry_type, folder_id, parent_entry_id, tags, config });
const folders = [{ id: 'F1', parent_id: null }, { id: 'F2', parent_id: 'F1' }];
const entries = [
  e('X', 'web-01', { folder_id: 'F2', tags: ['linux'], entry_type: 'ssh' }),
  e('Y', 'web-01 db', { parent_entry_id: 'X', entry_type: 'ssh' }),
  e('a1', 'Reboot', { parent_entry_id: 'X', config: kb('asset', 'procedure') }),
  e('a2', 'Overview', { parent_entry_id: 'X', config: kb('asset', 'overview') }),
  e('a3', 'b facts', { parent_entry_id: 'X', config: kb('asset', 'facts') }),
  e('a4', 'Zed', { parent_entry_id: 'X', config: kb('asset', 'troubleshooting', { pinned: true }) }),
  e('a5', 'Old', { parent_entry_id: 'X', config: kb('asset', 'facts', { status: 'archived' }) }),
  e('a6', 'apply patches', { parent_entry_id: 'X', config: kb('asset', 'procedure') }),
  e('a7', 'Check later', { parent_entry_id: 'X', config: kb('asset', 'facts', { status: 'needs_review' }) }),
  e('d1', 'Plain doc', { parent_entry_id: 'X', config: { content: 'x' } }),
  e('s1', 'Local admin', { parent_entry_id: 'X', entry_type: 'credential', config: { embedded: { owner_id: 'X', label: 'Local admin' } } }),
  e('y1', 'Y facts', { parent_entry_id: 'Y', config: kb('asset', 'facts') }),
  e('f1', 'Net', { folder_id: 'F2', config: kb('folder', 'facts') }),
  e('f2', 'Client', { folder_id: 'F1', config: kb('folder', 'overview') }),
  e('v1', 'Patch', { tags: ['Linux'], config: kb('vault', 'playbook') }),
  e('v2', 'Win', { tags: ['windows'], config: kb('vault', 'playbook') }),
  e('v3', 'Policies', { config: kb('vault', 'facts', { pinned: true }) }),
  e('v4', 'Archived pinned', { config: kb('vault', 'facts', { pinned: true, status: 'archived' }) }),
  e('a8', 'aaa no pinned key', { parent_entry_id: 'X', config: { kb: { v: 1, scope: 'asset', kind: 'procedure', summary: '', status: 'active' } } }),
];
const g = (id, group) => ({ id, group });
write('inherit.json', 'inherit', [
  'knowledgeFor(target, entries, folders) returns {id, group} in display order. target is {entry_id} or {folder_id}. Section 4.',
  'groups are "asset", "folder" and "vault". A missing pinned counts as false.',
], [
  { name: 'asset in a nested folder', fn: 'knowledgeFor', input: { target: { entry_id: 'X' }, entries, folders }, expect: [
    g('a4', 'asset'), g('a2', 'asset'), g('a3', 'asset'), g('a7', 'asset'), g('a8', 'asset'), g('a6', 'asset'), g('a1', 'asset'),
    g('f1', 'folder'), g('f2', 'folder'),
    g('v3', 'vault'), g('v1', 'vault'),
  ] },
  { name: 'nested asset uses ancestor folder', fn: 'knowledgeFor', input: { target: { entry_id: 'Y' }, entries, folders }, expect: [
    g('y1', 'asset'), g('f1', 'folder'), g('f2', 'folder'), g('v3', 'vault'),
  ] },
  { name: 'folder', fn: 'knowledgeFor', input: { target: { folder_id: 'F2' }, entries, folders }, expect: [
    g('f1', 'folder'), g('f2', 'folder'), g('v3', 'vault'),
  ] },
  { name: 'root folder', fn: 'knowledgeFor', input: { target: { folder_id: 'F1' }, entries, folders }, expect: [
    g('f2', 'folder'), g('v3', 'vault'),
  ] },
]);

// ---- revisions
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const t = (m) => new Date(T0 + m * 60000).toISOString();
const user = { kind: 'user', device: 'desktop' };
const agent = { kind: 'agent', name: 'Claude Code' };
const save = (m, author, content) => ({ op: 'save', at: t(m), author, content });
const after = (count, latest_content, unseen, baseline_content) => ({ count, latest_content, unseen, baseline_content });
const many = [];
const manyExpect = [];
many.push(save(0, user, 'c0'));
manyExpect.push(after(1, 'c0', false, 'c0'));
for (let i = 1; i <= 25; i++) {
  many.push(save(i, agent, `c${i}`));
  manyExpect.push(after(Math.min(i + 1, 21), `c${i}`, true, 'c0'));
}
many.push({ op: 'keep' });
manyExpect.push(after(21, 'c25', false, 'c25'));
many.push(save(26, agent, 'c26'));
manyExpect.push(after(20, 'c26', true, 'c25'));
write('revisions.json', 'revisions', [
  'Run steps in order on an article that starts with no history and no reviewed_at. Section 5.',
  'save appends {at, author, content} and sets last_editor = author + at. keep sets reviewed_at to the newest revision at.',
  'undo appends the baseline content as {kind:"user"} with reason "Undo agent edits" at the given time and sets reviewed_at to it; with no baseline the step expects {error:"no_baseline"} and changes nothing.',
  'after each step, expect count (history length), latest_content, unseen and baseline_content (null when there is no baseline).',
], [
  { name: 'undo an agent edit', fn: 'revisionScript', input: [save(1, user, 'c1'), save(2, agent, 'c2'), { op: 'undo', at: t(3) }], expect: [
    after(1, 'c1', false, 'c1'), after(2, 'c2', true, 'c1'), after(3, 'c1', false, 'c1'),
  ] },
  { name: 'agent-created article has no baseline', fn: 'revisionScript', input: [save(1, agent, 'c1'), { op: 'undo', at: t(2) }], expect: [
    after(1, 'c1', true, null), { error: 'no_baseline' },
  ] },
  { name: 'keep moves the baseline', fn: 'revisionScript', input: [save(1, user, 'c1'), save(2, agent, 'c2'), { op: 'keep' }, save(3, agent, 'c3'), { op: 'undo', at: t(4) }], expect: [
    after(1, 'c1', false, 'c1'), after(2, 'c2', true, 'c1'), after(2, 'c2', false, 'c2'), after(3, 'c3', true, 'c2'), after(4, 'c2', false, 'c2'),
  ] },
  { name: 'user edit after agent clears unseen', fn: 'revisionScript', input: [save(1, agent, 'c1'), save(2, user, 'c2')], expect: [
    after(1, 'c1', true, null), after(2, 'c2', false, 'c2'),
  ] },
  { name: 'cap keeps the baseline', fn: 'revisionScript', input: many, expect: manyExpect },
]);

// ---- changelog
write('changelog.json', 'changelog', ['formatLine({at, name, text}) and insertLine({content, line}). Section 8.'], [
  { name: 'agent line', fn: 'formatLine', input: { at: '2026-10-06T14:03:59.123Z', name: 'Claude Code', text: 'Rotated pw.' }, expect: '- 2026-10-06 14:03 UTC · Claude Code: Rotated pw.' },
  { name: 'user line', fn: 'formatLine', input: { at: '2026-01-02T03:04:00.000Z', name: null, text: 'Replaced disk' }, expect: '- 2026-01-02 03:04 UTC · You: Replaced disk' },
  { name: 'line breaks become spaces', fn: 'formatLine', input: { at: '2026-01-02T03:04:00.000Z', name: 'Codex', text: '  a\nb\r\nc  ' }, expect: '- 2026-01-02 03:04 UTC · Codex: a b c' },
  { name: 'empty body', fn: 'insertLine', input: { content: '', line: '- L' }, expect: '- L' },
  { name: 'heading and blank line', fn: 'insertLine', input: { content: '# Change log\n\n- old', line: '- L' }, expect: '# Change log\n\n- L\n- old' },
  { name: 'heading without blank line', fn: 'insertLine', input: { content: '# Change log\n- old', line: '- L' }, expect: '# Change log\n- L\n- old' },
  { name: 'heading only', fn: 'insertLine', input: { content: '# Change log', line: '- L' }, expect: '# Change log\n\n- L' },
  { name: 'heading and trailing newline', fn: 'insertLine', input: { content: '# Change log\n', line: '- L' }, expect: '# Change log\n\n- L' },
  { name: 'no heading', fn: 'insertLine', input: { content: '- old', line: '- L' }, expect: '- L\n- old' },
]);

// ---- auto-resolution of metadata and history conflicts (5.1)
const meta = (at, extra = {}) => ({ v: 1, scope: 'asset', kind: 'facts', summary: '', pinned: false, status: 'active', author: { kind: 'user' }, last_editor: { kind: 'user', at }, ...extra });
const rev = (m, content, kind = 'user') => ({ at: t(m), author: { kind }, content });
const manyA = [rev(0, 'c0')];
const manyB = [rev(0, 'c0')];
for (let i = 1; i <= 15; i++) manyA.push(rev(i * 2 - 1, `a${i}`, 'agent'));
for (let i = 1; i <= 15; i++) manyB.push(rev(i * 2, `b${i}`, 'agent'));
const manyMerged = [rev(0, 'c0')];
for (let m = 1; m <= 30; m++) manyMerged.push(rev(m, m % 2 ? `a${(m + 1) / 2}` : `b${m / 2}`, 'agent'));
write('autoresolve.json', 'autoresolve', [
  'mergeKbMeta(versions) and mergeKbHistory({versions, reviewed_at}). Section 5.1.',
  'mergeKbHistory builds the result with the append rule of section 5 (cap 20 plus the baseline).',
], [
  { name: 'newest editor wins', fn: 'mergeKbMeta', input: [meta(t(1), { summary: 'old' }), meta(t(2), { summary: 'new' })], expect: meta(t(2), { summary: 'new' }) },
  { name: 'reviewed_at is the latest of all versions', fn: 'mergeKbMeta', input: [meta(t(5), { reviewed_at: t(1) }), meta(t(3), { reviewed_at: t(4) })], expect: meta(t(5), { reviewed_at: t(4) }) },
  { name: 'tie broken by JSON text', fn: 'mergeKbMeta', input: [meta(t(2), { summary: 'b' }), meta(t(2), { summary: 'a' })], expect: meta(t(2), { summary: 'b' }) },
  { name: 'missing last_editor sorts first', fn: 'mergeKbMeta', input: [meta(t(1)), { v: 1, scope: 'asset', kind: 'facts', summary: 'x', pinned: false, status: 'active', author: { kind: 'user' } }], expect: meta(t(1)) },
  { name: 'union without duplicates, sorted', fn: 'mergeKbHistory', input: { versions: [[rev(1, 'a'), rev(3, 'c')], [rev(1, 'a'), rev(2, 'b')]], reviewed_at: null }, expect: [rev(1, 'a'), rev(2, 'b'), rev(3, 'c')] },
  { name: 'same time, different content keeps both', fn: 'mergeKbHistory', input: { versions: [[rev(1, 'y')], [rev(1, 'x')]], reviewed_at: null }, expect: [rev(1, 'x'), rev(1, 'y')] },
  { name: 'cap keeps the baseline', fn: 'mergeKbHistory', input: { versions: [manyA, manyB], reviewed_at: null }, expect: [manyMerged[0], ...manyMerged.slice(-20)] },
]);

console.log('wrote', fs.readdirSync(out));
