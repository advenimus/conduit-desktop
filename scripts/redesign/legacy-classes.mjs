#!/usr/bin/env node
// Lists the legacy Tailwind patterns of docs/VISUAL_REDESIGN.md section 4.16 that a wave-3 package
// replaces in its directory. It reads class strings only (className and class attributes, cx()/clsx()
// arguments and values named like *className or *Classes), so words such as the `uppercase` option in
// src/utils/passwordGenerator.ts are not findings. Classes the harness still reads (Appendix B) are
// allowed until the file carries the matching data-cv hook; the dead files of section 10.5 are skipped.
//
//   node scripts/redesign/legacy-classes.mjs [--json] [path ...]   (default path: src)
//   exit 0: no findings; 1: findings; 2: bad path or read error

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const DEAD_FILES = Object.freeze([
  'src/components/vault/TeamVaultMembersDialog.tsx',
  'src/components/connections/ConnectionTree.tsx',
  'src/components/layout/TabBar.tsx',
  'src/components/vault/FolderPermissionEditor.tsx',
  'src/components/vault/VaultSelector.tsx',
  'src/components/layout/MainContent.tsx',
  'src/components/ai/McpSetupPopover.tsx',
  'src/components/common/ContextMenu.tsx',
  'src/components/upgrade/UpgradeGate.tsx',
]);

/**
 * Appendix B classes the harness still reads: {ref, file, token, tag?, hook}, `tag` narrowing an entry
 * to one element type. Empty since the wave-3 integration: every entry's class is gone and its hook landed.
 */
export const APPENDIX_B_ALLOWLIST = Object.freeze([]);

const FAMILIES = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const colorUtility = (families) =>
  new RegExp(`^(?:text|bg|border|ring|outline|fill|stroke|divide|from|via|to|placeholder|accent|decoration|caret|shadow)(?:-[xytrblse])?-(?:${families})-(?:50|[1-9]00|950)(?:/\\S+)?$`);
const OTHER_FAMILIES = FAMILIES.split('|').filter((f) => !['red', 'amber', 'yellow', 'green', 'emerald'].includes(f)).join('|');

const is = (...names) => ({ utility }) => names.includes(utility);
const has = (variants, ...names) => variants.some((v) => names.includes(v));

/** Token rules, first match wins: test({variants, utility}, {tag, tokens}). */
export const RULES = Object.freeze([
  { id: 'bg-canvas', test: is('bg-canvas'), suggestion: 'bg-editor' },
  { id: 'bg-panel', test: is('bg-panel'), suggestion: 'bg-overlay through Dialog or Popover on overlays; bg-sidebar on side panels' },
  {
    id: 'hover-surface',
    test: ({ variants, utility }) => has(variants, 'hover') && ['bg-raised', 'bg-well', 'bg-stroke'].includes(utility),
    suggestion: 'hover:bg-hover',
  },
  {
    id: 'code-block-bg',
    test: ({ variants, utility }, { tag, tokens }) =>
      ['bg-well', 'bg-raised'].includes(utility) && (has(variants, 'prose-pre', 'prose-code') || ['pre', 'code'].includes(tag) || tokens.includes('font-mono')),
    suggestion: 'bg-code',
  },
  { id: 'accent-selection', test: ({ utility }) => /^bg-conduit-\d+\/\d+$/.test(utility), suggestion: 'bg-selected text-ink (D-13)' },
  { id: 'accent-fill', test: ({ utility }) => /^bg-conduit-\d+$/.test(utility), suggestion: 'Button variant="primary"' },
  {
    id: 'accent-text',
    test: ({ utility }) => /^text-conduit-\d+$/.test(utility),
    suggestion: 'text-link hover:text-link-hover or Button variant="link"; text-ink on a selected row',
  },
  { id: 'danger-color', test: ({ utility }) => colorUtility('red').test(utility), suggestion: 'text-danger; Callout tone="danger" for tinted boxes; Button variant="danger"' },
  { id: 'warning-color', test: ({ utility }) => colorUtility('amber|yellow').test(utility), suggestion: 'text-warning, bg-warning-bg, border-warning-border' },
  { id: 'success-color', test: ({ utility }) => colorUtility('green|emerald').test(utility), suggestion: 'text-success, bg-success-bg, border-success-border' },
  { id: 'palette-color', test: ({ utility }) => colorUtility(OTHER_FAMILIES).test(utility), suggestion: 'a token color: text-entry-* for entry types, ink, accent or state tokens elsewhere' },
  { id: 'arbitrary-text-size', test: is('text-[10px]', 'text-[11px]'), suggestion: 'text-badge (10px) or text-meta (11px)' },
  { id: 'overlay-chrome', test: is('rounded-xl', 'shadow-xl', 'backdrop-blur-sm'), suggestion: 'the Dialog primitive (radius 8, modal shadow, no blur)' },
  { id: 'heading-size', test: is('text-2xl', 'text-xl'), suggestion: 'text-display or text-title' },
  {
    id: 'text-base',
    test: ({ variants, utility }) => utility === 'text-base' && !variants.some((v) => v.startsWith('prose')),
    suggestion: 'text-heading for dialog titles, text-body elsewhere',
  },
  {
    id: 'uppercase-label',
    test: is('uppercase', 'tracking-wide', 'tracking-wider', 'tracking-widest'),
    suggestion: 'SectionHeader, or text-meta font-semibold text-ink-muted in title case',
  },
  {
    id: 'focus-ring',
    test: ({ variants, utility }) =>
      (has(variants, 'focus', 'focus-visible', 'focus-within') && /^ring(-|$)/.test(utility)) || (has(variants, 'focus') && ['outline-none', 'outline-hidden'].includes(utility)),
    suggestion: 'remove it: the global focus rule draws the ring (spec 2.7, R19)',
  },
  { id: 'revived-class', test: is('text-accent'), suggestion: 'text-link (text-accent had no color before wave 1, R18)' },
]);

/** Rules on a whole class string; they return the token to report or null. */
export const STRING_RULES = Object.freeze([
  {
    id: 'css-spinner',
    test: ({ tokens }) => (tokens.includes('animate-spin') && tokens.some((t) => /^border-(2|b-2|t-transparent|r-transparent)$/.test(t)) ? 'animate-spin' : null),
    suggestion: 'Spinner',
  },
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const CLASS_NAME = /class(name|names|es)?$/i;
const CLASS_CALLS = new Set(['cx', 'clsx', 'cn', 'classNames', 'twMerge']);

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function nameOf(node) {
  if (!node) return '';
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isJsxNamespacedName?.(node)) return node.name.text;
  return '';
}

function elementTag(attribute) {
  const element = attribute.parent?.parent;
  if (element && (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element))) return element.tagName.getText();
  return null;
}

/** Every string piece under `node`: literals, template heads and spans, nested ternaries included. */
function collectStrings(node, tag, out) {
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push({ text: n.text, start: n.getStart() + 1, tag });
      return;
    }
    if (ts.isTemplateExpression(n)) {
      out.push({ text: n.head.text, start: n.head.getStart() + 1, tag });
      for (const span of n.templateSpans) {
        visit(span.expression);
        out.push({ text: span.literal.text, start: span.literal.getStart() + 1, tag });
      }
      return;
    }
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/** Class strings of one source file in source order, each once. */
export function classStrings(sf) {
  const found = [];
  const visit = (node) => {
    if (ts.isJsxAttribute(node) && CLASS_NAME.test(nameOf(node.name)) && node.initializer) {
      collectStrings(node.initializer, elementTag(node), found);
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CLASS_CALLS.has(node.expression.text)) {
      for (const arg of node.arguments) collectStrings(arg, null, found);
      return;
    }
    const named = ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node);
    if (named && node.initializer && CLASS_NAME.test(nameOf(node.name))) {
      collectStrings(node.initializer, null, found);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const seen = new Set();
  return found.filter((s) => !seen.has(s.start) && seen.add(s.start)).sort((a, b) => a.start - b.start);
}

/** Splits "hover:bg-x" into variants and utility, ignoring colons inside brackets. */
export function parseToken(token) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of token) {
    if (ch === '[' || ch === '(') depth += 1;
    if (ch === ']' || ch === ')') depth -= 1;
    if (ch === ':' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  return { variants: parts, utility: current.replace(/^!/, '').replace(/!$/, '').replace(/^-/, '') };
}

function allowEntry(allowlist, file, token, tag, source) {
  return allowlist.find((e) => e.file === file && e.token === token && (!e.tag || e.tag === tag) && !source.includes(e.hook));
}

function matchesIn(str) {
  const tokens = [...str.text.matchAll(/\S+/g)].map((m) => ({ token: m[0], offset: m.index }));
  const context = { tag: str.tag, tokens: tokens.map((t) => t.token) };
  const matches = [];
  for (const { token, offset } of tokens) {
    const rule = RULES.find((r) => r.test(parseToken(token), context));
    if (rule) matches.push({ token, offset, rule });
  }
  for (const rule of STRING_RULES) {
    const token = rule.test(context);
    if (token) matches.push({ token, offset: str.text.indexOf(token), rule });
  }
  return matches;
}

/** Findings of one file. `file` is the repo-relative path the allowlist and the report use. */
export function scanSource(source, { file, allowlist = APPENDIX_B_ALLOWLIST }) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const findings = [];
  const allowlisted = [];
  for (const str of classStrings(sf)) {
    for (const { token, offset, rule } of matchesIn(str)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(str.start + offset);
      const finding = { file, line: line + 1, column: character + 1, token, rule: rule.id, suggestion: rule.suggestion };
      (allowEntry(allowlist, file, token, str.tag, source) ? allowlisted : findings).push(finding);
    }
  }
  const byPosition = (a, b) => a.line - b.line || a.column - b.column;
  return { findings: findings.sort(byPosition), allowlisted: allowlisted.sort(byPosition) };
}

function isSkipped(rel) {
  const parts = rel.split('/');
  return DEAD_FILES.includes(rel) || parts.includes('__tests__') || parts.includes('node_modules') || /\.test\.[cm]?[jt]sx?$/.test(rel);
}

function listFiles(abs, rel) {
  if (fs.statSync(abs).isFile()) return SOURCE_EXTENSIONS.has(path.extname(abs)) && !isSkipped(rel) ? [rel] : [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => (entry.isDirectory() && ['node_modules', '__tests__'].includes(entry.name) ? [] : listFiles(path.join(abs, entry.name), rel ? `${rel}/${entry.name}` : entry.name)));
}

/** Scans files and directories relative to cwd. Throws on a path that does not exist. */
export function scanPaths(paths, { cwd = process.cwd() } = {}) {
  const files = [
    ...new Set(
      paths.flatMap((p) => {
        const abs = path.resolve(cwd, p);
        if (!fs.existsSync(abs)) throw new Error(`no such file or directory: ${p}`);
        return listFiles(abs, path.relative(cwd, abs).split(path.sep).join('/'));
      }),
    ),
  ];
  const results = files.map((rel) => scanSource(fs.readFileSync(path.join(cwd, rel), 'utf8'), { file: rel }));
  return { files: files.length, findings: results.flatMap((r) => r.findings), allowlisted: results.flatMap((r) => r.allowlisted) };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : word.endsWith('s') ? 'es' : 's'}`;

export function formatReport({ files, findings, allowlisted }) {
  const byFile = new Map();
  for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  const lines = [...byFile].flatMap(([file, list]) => [file, ...list.map((f) => `  ${f.line}:${f.column}  ${f.token}  [${f.rule}] ${f.suggestion}`), '']);
  lines.push(
    findings.length === 0
      ? `0 findings in ${plural(files, 'file')} scanned`
      : `${plural(findings.length, 'finding')} in ${plural(byFile.size, 'file')} (${plural(files, 'file')} scanned)`,
  );
  if (allowlisted.length > 0) lines.push(`${plural(allowlisted.length, 'class')} kept for the harness until their Appendix B hook lands`);
  return lines.join('\n');
}

function main(argv) {
  const json = argv.includes('--json');
  const paths = argv.filter((a) => a !== '--json');
  let result;
  try {
    result = scanPaths(paths.length > 0 ? paths : ['src']);
  } catch (err) {
    console.error(`legacy-classes: ${err.message}`);
    return 2;
  }
  console.log(json ? JSON.stringify(result, null, 2) : formatReport(result));
  return result.findings.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
