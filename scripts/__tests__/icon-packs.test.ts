// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEMANTIC_ICON_NAMES, ICON_PACKS } from '../../src/lib/icons/types';

interface GlyphNode {
  tag: string;
  attrs: Record<string, string>;
  children?: GlyphNode[];
}

interface MappingRow {
  name: string;
  codicon: string | null;
  codiconCompact: string | null;
  material: string;
  materialFill: boolean;
}

interface LicenseSource {
  id: string;
  packageName: string;
  license: string;
  notice: string;
}

interface IconifySet {
  prefix: string;
  icons: Record<string, { body: string; width?: number; height?: number }>;
  aliases?: Record<string, { parent: string }>;
  width?: number;
  height?: number;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'icons', 'generate-icon-packs.mjs');

// The generator is plain .mjs without type declarations.
const generator = (await import('../icons/generate-icon-packs.mjs' as string)) as {
  parseIconBody(body: string): GlyphNode[];
  resolveIconifyIcon(set: IconifySet, name: string): { body: string; width: number; height: number };
  generateOutputs(root?: string): Record<string, string>;
  findStaleOutputs(root?: string): string[];
  LICENSE_SOURCES: readonly LicenseSource[];
  OUTPUT_FILES: Record<'codicons' | 'material' | 'licenses', string>;
};
const { ICON_MAPPING } = (await import('../icons/mapping.mjs' as string)) as { ICON_MAPPING: readonly MappingRow[] };

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
const installedVersion = (pkg: string) =>
  readJson<{ version: string }>(path.join(ROOT, 'node_modules', ...pkg.split('/'), 'package.json')).version;

describe('icon generator --check', () => {
  it('reports the checked-in packs and license file as up to date', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('names a stale or missing output', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-icons-'));
    try {
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
      for (const file of Object.values(generator.OUTPUT_FILES)) {
        fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, file), path.join(tmp, file));
      }
      expect(generator.findStaleOutputs(tmp)).toEqual([]);

      fs.appendFileSync(path.join(tmp, generator.OUTPUT_FILES.material), '// edited\n');
      fs.rmSync(path.join(tmp, generator.OUTPUT_FILES.licenses));
      expect(generator.findStaleOutputs(tmp).sort()).toEqual(
        [generator.OUTPUT_FILES.licenses, generator.OUTPUT_FILES.material].sort(),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('writes nothing in check mode', () => {
    const before = Object.values(generator.OUTPUT_FILES).map((file) => fs.statSync(path.join(ROOT, file)).mtimeMs);
    spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: ROOT });
    const after = Object.values(generator.OUTPUT_FILES).map((file) => fs.statSync(path.join(ROOT, file)).mtimeMs);
    expect(after).toEqual(before);
  });
});

describe('icon mapping source', () => {
  it('lists exactly the 123 semantic names, in registry order', () => {
    expect(SEMANTIC_ICON_NAMES).toHaveLength(123);
    expect(ICON_MAPPING.map((row) => row.name)).toEqual([...SEMANTIC_ICON_NAMES]);
  });

  it('has 36 compact Codicon twins and 8 Lucide fallbacks', () => {
    expect(ICON_MAPPING.filter((row) => row.codiconCompact)).toHaveLength(36);
    expect(ICON_MAPPING.filter((row) => row.codiconCompact).every((row) => row.codiconCompact!.endsWith('-compact'))).toBe(true);
    expect(ICON_MAPPING.filter((row) => row.codicon === null).map((row) => row.name).sort()).toEqual(
      ['bolt', 'cloudOff', 'crown', 'fileX', 'fingerprint', 'heading1', 'heading2', 'qrcode'],
    );
  });

  it('marks the four filled Material glyphs', () => {
    expect(ICON_MAPPING.filter((row) => row.materialFill).map((row) => row.name).sort()).toEqual(
      ['circleFilled', 'pinFilled', 'playerStopFilled', 'starFilled'],
    );
  });

  it('pairs the shown and hidden layout glyphs', () => {
    const byName = new Map(ICON_MAPPING.map((row) => [row.name, row]));
    expect(byName.get('panelLeft')?.codicon).toBe('layout-sidebar-left');
    expect(byName.get('panelLeftOff')?.codicon).toBe('layout-sidebar-left-off');
    expect(byName.get('panelRight')?.codicon).toBe('layout-sidebar-right');
    expect(byName.get('panelRightOff')?.codicon).toBe('layout-sidebar-right-off');
    expect(byName.get('panelLeft')?.material).toBe('left-panel-close-outline-rounded');
    expect(byName.get('panelLeftOff')?.material).toBe('left-panel-open-outline-rounded');
  });
});

describe('icon body parser', () => {
  it('accepts paths and groups with the allowlisted attributes', () => {
    const nodes = generator.parseIconBody(
      '<g fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" opacity=".5" transform="translate(1 2)">' +
        '<path d="M1 1h2v2z"/></g><path fill="none" d="m0 0l4 4"/>',
    );
    expect(nodes).toEqual([
      {
        tag: 'g',
        attrs: { fill: 'currentColor', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd', opacity: '.5', transform: 'translate(1 2)' },
        children: [{ tag: 'path', attrs: { d: 'M1 1h2v2z' } }],
      },
      { tag: 'path', attrs: { fill: 'none', d: 'm0 0l4 4' } },
    ]);
  });

  it.each([
    ['a script element', '<script>alert(1)</script>'],
    ['a use element', '<use href="#a"/>'],
    ['a foreignObject element', '<foreignObject><div/></foreignObject>'],
    ['an event handler', '<path d="M0 0" onload="alert(1)"/>'],
    ['an onclick on a group', '<g onclick="x()"><path d="M0 0"/></g>'],
    ['an href', '<path d="M0 0" href="#x"/>'],
    ['an xlink:href', '<path d="M0 0" xlink:href="#x"/>'],
    ['a style attribute', '<path d="M0 0" style="fill:red"/>'],
    ['a stroke attribute', '<path d="M0 0" stroke="currentColor"/>'],
    ['text content', 'hello<path d="M0 0"/>'],
    ['an unclosed group', '<g><path d="M0 0"/>'],
    ['a stray closing tag', '<path d="M0 0"/></g>'],
    ['a path with children', '<path d="M0 0"><path d="M1 1"/></path>'],
    ['a path without d', '<path fill="currentColor"/>'],
    ['single-quoted attributes', "<path d='M0 0'/>"],
    ['a url in fill', '<path d="M0 0" fill="url(#g)"/>'],
    ['script in path data', '<path d="javascript:alert(1)"/>'],
    ['a duplicate attribute', '<path d="M0 0" d="M1 1"/>'],
    ['an empty body', '  '],
  ])('rejects %s', (_label, body) => {
    expect(() => generator.parseIconBody(body)).toThrow();
  });
});

describe('iconify resolution', () => {
  const codicon = readJson<IconifySet>(path.join(ROOT, 'node_modules/@iconify-json/codicon/icons.json'));
  const material = readJson<IconifySet>(path.join(ROOT, 'node_modules/@iconify-json/material-symbols-light/icons.json'));

  it('honors per-icon sizes', () => {
    for (const name of ['settings-gear', 'terminal', 'files']) {
      expect(generator.resolveIconifyIcon(codicon, name)).toMatchObject({ width: 24, height: 24 });
    }
    expect(generator.resolveIconifyIcon(codicon, 'close')).toMatchObject({ width: 16, height: 16 });
    expect(generator.resolveIconifyIcon(codicon, 'close-compact')).toMatchObject({ width: 12, height: 12 });
    expect(generator.resolveIconifyIcon(material, 'close-outline-rounded')).toMatchObject({ width: 24, height: 24 });
  });

  it('follows aliases and fails on unknown names', () => {
    expect(material.icons['close-outline-rounded']).toBeUndefined();
    expect(generator.resolveIconifyIcon(material, 'close-outline-rounded').body).toContain('<path');
    expect(() => generator.resolveIconifyIcon(codicon, 'no-such-icon')).toThrow(/not found/);
  });
});

describe('third-party license file', () => {
  const text = fs.readFileSync(path.join(ROOT, generator.OUTPUT_FILES.licenses), 'utf8');

  it('lists every pack with its installed version and notice', () => {
    for (const source of generator.LICENSE_SOURCES) {
      expect(text).toContain(`Package: ${source.packageName} ${installedVersion(source.packageName)}`);
      expect(text).toContain(`License: ${source.license}`);
      expect(text).toContain(source.notice);
    }
  });

  it('carries the Codicons attribution and the CC BY and Apache texts', () => {
    expect(text).toContain('Codicons © Microsoft Corporation, licensed under CC BY 4.0. Converted from SVG to React path data.');
    expect(text).toContain('Attribution 4.0 International');
    expect(text).toContain('Apache License');
    expect(text).toContain('Version 2.0, January 2004');
    expect(text).not.toContain('\r');
  });
});

describe('icon package metadata', () => {
  const pkg = readJson<{ dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> }>(
    path.join(ROOT, 'package.json'),
  );

  it('keeps every icon library in devDependencies', () => {
    const libraries = ICON_PACKS.map((pack) => pack.packageName);
    for (const name of libraries) {
      expect(pkg.dependencies[name]).toBeUndefined();
      expect(pkg.devDependencies[name]).toBeDefined();
    }
    expect(pkg.devDependencies['@iconify-json/codicon']).toBe('1.2.73');
    expect(pkg.devDependencies['@iconify-json/material-symbols-light']).toBe('1.2.94');
    expect(pkg.devDependencies['lucide-react']).toBe('1.48.0');
    expect(pkg.scripts['icons:generate']).toBe('node scripts/icons/generate-icon-packs.mjs');
  });

  it('matches ICON_PACKS to the installed versions and the license sources', () => {
    const sources = new Map(generator.LICENSE_SOURCES.map((source) => [source.id, source]));
    expect(ICON_PACKS.map((pack) => pack.id)).toEqual(['codicons', 'lucide', 'tabler', 'phosphor', 'fluent', 'material']);
    for (const pack of ICON_PACKS) {
      expect(pack.version).toBe(installedVersion(pack.packageName));
      expect(sources.get(pack.id)).toMatchObject({ packageName: pack.packageName, license: pack.license });
    }
  });
});
