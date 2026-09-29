// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface Finding { file: string; line: number; column: number; token: string; rule: string; suggestion: string }
interface ScanResult { findings: Finding[]; allowlisted: Finding[] }
interface AllowEntry { ref: string; file: string; token: string; tag?: string; hook: string }

// The redesign scripts are plain .mjs without type declarations.
const legacy = (await import('../redesign/legacy-classes.mjs' as string)) as {
  scanSource(source: string, opts: { file: string; allowlist?: AllowEntry[] }): ScanResult;
  scanPaths(paths: string[], opts?: { cwd?: string }): ScanResult & { files: number };
  formatReport(result: ScanResult & { files: number }): string;
  DEAD_FILES: string[];
  APPENDIX_B_ALLOWLIST: AllowEntry[];
};

const SCRIPT = path.resolve(__dirname, '../redesign/legacy-classes.mjs');
const REPO = path.resolve(__dirname, '../..');

function rulesIn(source: string, file = 'src/components/x/Sample.tsx'): string[] {
  return legacy.scanSource(source, { file }).findings.map((f) => `${f.rule}:${f.token}`);
}

describe('the 4.16 patterns inside className strings', () => {
  const cases: Array<[string, string]> = [
    ['bg-canvas', 'bg-canvas'],
    ['bg-panel', 'bg-panel'],
    ['hover:bg-raised', 'hover-surface'],
    ['hover:bg-well', 'hover-surface'],
    ['hover:bg-stroke', 'hover-surface'],
    ['bg-conduit-600/20', 'accent-selection'],
    ['bg-conduit-500/10', 'accent-selection'],
    ['text-conduit-400', 'accent-text'],
    ['hover:text-conduit-300', 'accent-text'],
    ['bg-conduit-600', 'accent-fill'],
    ['hover:bg-conduit-700', 'accent-fill'],
    ['text-red-400', 'danger-color'],
    ['bg-red-500/10', 'danger-color'],
    ['border-red-500/20', 'danger-color'],
    ['text-amber-400', 'warning-color'],
    ['text-yellow-500', 'warning-color'],
    ['bg-amber-500/10', 'warning-color'],
    ['text-green-400', 'success-color'],
    ['text-blue-400', 'palette-color'],
    ['text-[10px]', 'arbitrary-text-size'],
    ['text-[11px]', 'arbitrary-text-size'],
    ['rounded-xl', 'overlay-chrome'],
    ['shadow-xl', 'overlay-chrome'],
    ['backdrop-blur-sm', 'overlay-chrome'],
    ['text-2xl', 'heading-size'],
    ['text-xl', 'heading-size'],
    ['text-base', 'text-base'],
    ['uppercase', 'uppercase-label'],
    ['tracking-wide', 'uppercase-label'],
    ['tracking-wider', 'uppercase-label'],
    ['focus:ring-2', 'focus-ring'],
    ['focus:outline-none', 'focus-ring'],
    ['text-accent', 'revived-class'],
  ];

  it.each(cases)('%s is reported as %s', (token, rule) => {
    expect(rulesIn(`export const A = () => <div className="flex ${token} p-2" />;`)).toEqual([`${rule}:${token}`]);
  });

  it('reports the line, column and a suggestion', () => {
    const [finding] = legacy.scanSource('const x = 1;\nconst A = () => <p className="text-red-400">x</p>;\n', { file: 'src/a.tsx' }).findings;
    expect(finding).toMatchObject({ file: 'src/a.tsx', line: 2, token: 'text-red-400', rule: 'danger-color' });
    expect(finding.column).toBeGreaterThan(1);
    expect(finding.suggestion).toMatch(/text-danger/);
  });

  it('leaves the new token classes alone', () => {
    const clean = 'bg-editor bg-sidebar bg-overlay hover:bg-hover bg-selected text-ink text-link hover:text-link-hover text-danger bg-warning-bg text-meta text-badge text-title text-heading text-body bg-code rounded-lg shadow-modal font-semibold text-ink-muted border-accent';
    expect(rulesIn(`const A = () => <div className="${clean}" />;`)).toEqual([]);
  });
});

describe('where class strings are read', () => {
  it('reads cx() and clsx() arguments, template literals with nested ternaries, and class maps', () => {
    const src = `
      const TONE_CLASSES = { info: { box: "bg-conduit-500/10", icon: "text-conduit-400" } };
      const inputClass = "bg-panel";
      const A = ({ on }) => (
        <div className={\`px-2 \${on ? "bg-conduit-600/20" : "hover:bg-raised"} uppercase\`}>
          <span className={cx("p-1", on && "text-red-400")} />
          <Foo className={clsx(["tracking-wide"])} labelClassName="text-[10px]" />
        </div>
      );
      const props = { className: "shadow-xl" };
    `;
    expect(rulesIn(src).sort()).toEqual(
      [
        'accent-selection:bg-conduit-500/10',
        'accent-text:text-conduit-400',
        'bg-panel:bg-panel',
        'accent-selection:bg-conduit-600/20',
        'hover-surface:hover:bg-raised',
        'uppercase-label:uppercase',
        'danger-color:text-red-400',
        'uppercase-label:tracking-wide',
        'arbitrary-text-size:text-[10px]',
        'overlay-chrome:shadow-xl',
      ].sort(),
    );
  });

  it('ignores the same words outside class strings (passwordGenerator uppercase option)', () => {
    const src = `
      interface Options { uppercase: boolean; lowercase: boolean }
      const DEFAULTS = { uppercase: true, label: "uppercase" };
      if (opts.uppercase) chars += "ABC";
      // className="text-red-400 uppercase" in a comment
      const mode = status === "text-red-400" ? 1 : 0;
      const A = () => <p title="uppercase">Use uppercase and text-red-400 letters</p>;
    `;
    expect(rulesIn(src)).toEqual([]);
  });

  it('the real src/utils/passwordGenerator.ts has no findings', () => {
    expect(legacy.scanPaths(['src/utils/passwordGenerator.ts'], { cwd: REPO }).findings).toEqual([]);
  });

  it('keeps prose-*:text-base (markdown heading sizes) and reports a plain text-base', () => {
    const src = 'export const markdownProseClasses = ["prose-h2:text-base prose-h2:font-semibold"].join(" ");\nconst A = () => <h2 className="text-base" />;';
    expect(rulesIn(src)).toEqual(['text-base:text-base']);
  });

  it('reports bg-well and bg-raised only on code blocks', () => {
    const src = `
      const A = () => (
        <>
          <div className="bg-well rounded p-2" />
          <pre className="bg-well p-2" />
          <code className="bg-raised px-1" />
          <div className="bg-well font-mono text-xs" />
          <div className="prose prose-pre:bg-well prose-code:bg-raised" />
        </>
      );
    `;
    expect(rulesIn(src)).toEqual([
      'code-block-bg:bg-well',
      'code-block-bg:bg-raised',
      'code-block-bg:bg-well',
      'code-block-bg:prose-pre:bg-well',
      'code-block-bg:prose-code:bg-raised',
    ]);
  });

  it('reports CSS border spinners once per class string', () => {
    expect(rulesIn('const A = () => <div className="w-8 h-8 border-2 border-conduit-500 border-t-transparent rounded-full animate-spin" />;')).toContain(
      'css-spinner:animate-spin',
    );
    expect(rulesIn('const A = () => <Icon className="animate-spin" />;')).toEqual([]);
  });
});

describe('exclusions', () => {
  // The real allowlist is empty since the wave-3 integration; these fixtures keep the mechanism tested.
  const allowlist: AllowEntry[] = [
    { ref: 'B6', file: 'src/components/sync/SyncNoticeList.tsx', token: 'bg-amber-500/10', hook: 'data-cv-sync-notice' },
    { ref: 'B7', file: 'src/components/settings/tabs/SyncTab.tsx', token: 'text-amber-400', tag: 'p', hook: 'data-cv-sync-paused' },
  ];

  it('has no Appendix B entries left: every allowlisted class is gone', () => {
    expect(legacy.APPENDIX_B_ALLOWLIST).toEqual([]);
  });

  it('allows Appendix B classes until the file carries the matching hook', () => {
    const file = 'src/components/sync/SyncNoticeList.tsx';
    const before = legacy.scanSource('const A = () => <div className="p-2 bg-amber-500/10" />;', { file, allowlist });
    expect(before.findings).toEqual([]);
    expect(before.allowlisted.map((f) => f.token)).toEqual(['bg-amber-500/10']);

    const after = legacy.scanSource('const A = () => <div data-cv-sync-notice className="p-2 bg-amber-500/10" />;', { file, allowlist });
    expect(after.findings.map((f) => f.token)).toEqual(['bg-amber-500/10']);

    const elsewhere = legacy.scanSource('const A = () => <div className="bg-amber-500/10" />;', { file: 'src/components/sync/Other.tsx', allowlist });
    expect(elsewhere.findings.map((f) => f.token)).toEqual(['bg-amber-500/10']);
  });

  it('limits a tag-bound allowlist entry to that element (B7 is p.text-amber-400)', () => {
    const file = 'src/components/settings/tabs/SyncTab.tsx';
    const res = legacy.scanSource('const A = () => <><p className="text-amber-400" /><span className="text-amber-400" /></>;', { file, allowlist });
    expect(res.allowlisted).toHaveLength(1);
    expect(res.findings).toHaveLength(1);
  });

  it('skips the 10.5 dead files and test files', () => {
    expect(legacy.DEAD_FILES).toContain('src/components/layout/TabBar.tsx');
    expect(legacy.DEAD_FILES).toHaveLength(9);
    const res = legacy.scanPaths(['src/components/layout/TabBar.tsx', 'src/components/common/ContextMenu.tsx'], { cwd: REPO });
    expect(res.files).toBe(0);
    expect(res.findings).toEqual([]);
  });
});

describe('the command line', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-classes-'));
    fs.mkdirSync(path.join(dir, 'src', 'clean'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'old', '__tests__'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'clean', 'A.tsx'), 'export const A = () => <div className="bg-editor text-ink" />;\n');
    fs.writeFileSync(path.join(dir, 'src', 'old', 'B.tsx'), 'export const B = () => <div className="bg-panel uppercase" />;\n');
    fs.writeFileSync(path.join(dir, 'src', 'old', '__tests__', 'B.test.tsx'), 'render(<div className="bg-panel" />);\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prints 0 findings and exits 0 for a clean path', () => {
    const res = spawnSync(process.execPath, [SCRIPT, 'src/clean'], { cwd: dir, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^0 findings in 1 file scanned/m);
  });

  it('groups findings per path and exits 1', () => {
    const res = spawnSync(process.execPath, [SCRIPT, 'src'], { cwd: dir, encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('src/old/B.tsx');
    expect(res.stdout).toMatch(/1:\d+\s+bg-panel/);
    expect(res.stdout).toMatch(/1:\d+\s+uppercase/);
    expect(res.stdout).toMatch(/^2 findings in 1 file \(2 files scanned\)/m);
    expect(res.stdout).not.toContain('B.test.tsx');
  });

  it('prints JSON with --json', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--json', 'src/old'], { cwd: dir, encoding: 'utf8' });
    const parsed = JSON.parse(res.stdout) as { findings: Finding[] };
    expect(parsed.findings.map((f) => f.token).sort()).toEqual(['bg-panel', 'uppercase']);
  });

  it('exits 2 on a path that does not exist', () => {
    const res = spawnSync(process.execPath, [SCRIPT, 'src/missing'], { cwd: dir, encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('src/missing');
  });
});
