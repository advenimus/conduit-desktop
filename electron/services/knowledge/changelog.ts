/** Change-log article lines (docs/KNOWLEDGE_BASE.md section 8). */

export const CHANGELOG_TITLE = 'Change log';

export function formatChangelogLine(at: string, name: string | null | undefined, text: string): string {
  const stamp = `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
  const clean = text.trim().replace(/\r?\n/g, ' ');
  return `- ${stamp} · ${name || 'You'}: ${clean}`;
}

export function insertChangelogLine(content: string, line: string): string {
  if (content === '') return line;
  const lines = content.split('\n');
  if (!/^#{1,6}\s/.test(lines[0])) return [line, ...lines].join('\n');
  const index = lines.length > 1 && lines[1].trim() === '' ? 2 : 1;
  if (index >= lines.length) return `${lines[0]}\n\n${line}`;
  return [...lines.slice(0, index), line, ...lines.slice(index)].join('\n');
}
