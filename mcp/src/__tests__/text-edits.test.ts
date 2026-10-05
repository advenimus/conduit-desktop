// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { applyTextEdits } from '../text-edits.js';

const TEXT = '## Services\n- nginx 1.24\n- postgres 15\n\n## Notes\n- nginx reloads nightly\n';

describe('applyTextEdits', () => {
  it('replaces one exact match', () => {
    const out = applyTextEdits(TEXT, [{ old_string: '- postgres 15', new_string: '- postgres 16' }]);
    expect(out.text).toBe(TEXT.replace('postgres 15', 'postgres 16'));
    expect(out.replacements).toBe(1);
  });

  it('applies several edits in order', () => {
    const out = applyTextEdits(TEXT, [
      { old_string: '- postgres 15', new_string: '- postgres 16' },
      { old_string: '- postgres 16\n', new_string: '- postgres 16\n- redis 7\n' },
    ]);
    expect(out.text).toContain('- postgres 16\n- redis 7\n');
    expect(out.replacements).toBe(2);
  });

  it('fails when the text is not found', () => {
    expect(() => applyTextEdits(TEXT, [{ old_string: 'mysql', new_string: 'x' }])).toThrow(/edit 1: old_string was not found/);
  });

  it('fails on more than one match unless replace_all is set', () => {
    expect(() => applyTextEdits(TEXT, [{ old_string: 'nginx', new_string: 'caddy' }])).toThrow(/matches 2 places/);
    const out = applyTextEdits(TEXT, [{ old_string: 'nginx', new_string: 'caddy', replace_all: true }]);
    expect(out.text).not.toContain('nginx');
    expect(out.replacements).toBe(2);
  });

  it('treats $ in new_string as plain text', () => {
    expect(applyTextEdits('cost: X', [{ old_string: 'X', new_string: '$& $1 $$' }]).text).toBe('cost: $& $1 $$');
  });

  it('fails when old_string and new_string are the same', () => {
    expect(() => applyTextEdits(TEXT, [{ old_string: 'nginx 1.24', new_string: 'nginx 1.24' }])).toThrow(/the same/);
  });

  it('allows an empty old_string only to fill empty text', () => {
    expect(applyTextEdits('', [{ old_string: '', new_string: '# New' }]).text).toBe('# New');
    expect(() => applyTextEdits(TEXT, [{ old_string: '', new_string: 'x' }])).toThrow(/old_string is empty/);
  });

  it('names the failing edit when a later one fails', () => {
    expect(() =>
      applyTextEdits(TEXT, [
        { old_string: 'postgres 15', new_string: 'postgres 16' },
        { old_string: 'postgres 15', new_string: 'postgres 17' },
      ]),
    ).toThrow(/edit 2/);
  });

  it('requires at least one edit', () => {
    expect(() => applyTextEdits(TEXT, [])).toThrow(/at least one edit/);
  });
});
