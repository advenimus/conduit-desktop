// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface Pkg { id: string; wave: number; owns: string[] }
interface Plan { packages: Pkg[] }

// The redesign scripts are plain .mjs without type declarations.
const owns = (await import('../redesign/check-owns.mjs' as string)) as {
  ownsPath(patterns: string[], file: string): boolean;
  patternsOverlap(a: string, b: string): boolean;
  validatePlan(plan: Plan): void;
  waveOverlaps(plan: Plan, wave: number): { a: string; b: string; patternA: string; patternB: string }[];
  loadPlan(file: string): Plan;
};
const { countLintErrors } = (await import('../redesign/lint-count.mjs' as string)) as {
  countLintErrors(opts: { cwd: string; patterns?: string[] }): Promise<number>;
};

const SCRIPT = path.resolve(__dirname, '../redesign/check-owns.mjs');
const PLAN_FILE = path.resolve(__dirname, '../redesign/work-packages.json');
const SPEC_FILE = path.resolve(__dirname, '../../docs/VISUAL_REDESIGN.md');

describe('ownsPath', () => {
  it('matches exact paths and everything under a dir/** pattern', () => {
    const patterns = ['src/App.tsx', 'scripts/verify/**'];
    expect(owns.ownsPath(patterns, 'src/App.tsx')).toBe(true);
    expect(owns.ownsPath(patterns, 'scripts/verify/lib/flows.mjs')).toBe(true);
    expect(owns.ownsPath(patterns, 'scripts/verify/README.md')).toBe(true);
  });

  it('does not match siblings, prefixes of a name or parents', () => {
    const patterns = ['src/App.tsx', 'scripts/verify/**'];
    expect(owns.ownsPath(patterns, 'src/App.test.tsx')).toBe(false);
    expect(owns.ownsPath(patterns, 'scripts/verify-extra/x.mjs')).toBe(false);
    expect(owns.ownsPath(patterns, 'scripts/run.mjs')).toBe(false);
    expect(owns.ownsPath(patterns, 'src')).toBe(false);
  });
});

describe('patternsOverlap', () => {
  it('finds equal paths, a path under a dir pattern and nested dir patterns', () => {
    expect(owns.patternsOverlap('src/App.tsx', 'src/App.tsx')).toBe(true);
    expect(owns.patternsOverlap('src/**', 'src/App.tsx')).toBe(true);
    expect(owns.patternsOverlap('src/lib/icons/**', 'src/lib/**')).toBe(true);
  });

  it('keeps sibling directories and different files apart', () => {
    expect(owns.patternsOverlap('src/components/ui/**', 'src/components/uix/**')).toBe(false);
    expect(owns.patternsOverlap('src/App.tsx', 'src/App.test.tsx')).toBe(false);
    expect(owns.patternsOverlap('src/components/sync/**', 'src/components/settings/tabs/SyncTab.tsx')).toBe(false);
  });
});

describe('the package plan', () => {
  const plan = owns.loadPlan(PLAN_FILE);

  it('rejects owns patterns other than a path or dir/**', () => {
    const bad = { packages: [{ id: 'X', wave: 1, owns: ['src/*.ts'] }] };
    expect(() => owns.validatePlan(bad)).toThrow(/src\/\*\.ts/);
  });

  it('has no path owned by two packages of the same wave', () => {
    for (const wave of [1, 2, 3, 4]) expect(owns.waveOverlaps(plan, wave)).toEqual([]);
  });

  it('reports two packages of one wave that own the same path', () => {
    const clash = { packages: [{ id: 'A', wave: 1, owns: ['src/**'] }, { id: 'B', wave: 1, owns: ['src/App.tsx'] }, { id: 'C', wave: 2, owns: ['src/**'] }] };
    expect(owns.waveOverlaps(clash, 1)).toEqual([{ a: 'A', b: 'B', patternA: 'src/**', patternB: 'src/App.tsx' }]);
    expect(owns.waveOverlaps(clash, 2)).toEqual([]);
  });

  it('matches the Owns line of every package in spec section 10', () => {
    const spec = fs.readFileSync(SPEC_FILE, 'utf8');
    const heads = [...spec.matchAll(/^#### (\S+): /gm)];
    const fromSpec = heads.map((h, i) => {
      const body = spec.slice(h.index, heads[i + 1]?.index ?? spec.length);
      const line = body.match(/\*\*Owns:\*\* (.*)/)?.[1] ?? '';
      return { id: h[1], owns: [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]) };
    });
    expect(plan.packages.map((p) => ({ id: p.id, owns: p.owns }))).toEqual(fromSpec);
  });
});

// A commit starts a detached `git maintenance run --auto` that can still be writing into .git while
// afterEach deletes the repo (ENOTEMPTY under a loaded full run), so auto maintenance is off here.
const GIT_CONFIG = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_CONFIG, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
}

function write(root: string, file: string, text = 'x\n'): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

describe('check-owns.mjs', () => {
  let repo: string;
  let planFile: string;

  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args, '--plan', planFile], { cwd: repo, encoding: 'utf8' });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'check owns '));
    planFile = path.join(repo, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({
      packages: [
        { id: 'P1', wave: 1, owns: ['pkg/**', 'shared/one file.txt', 'plan.json'] },
        { id: 'P2', wave: 1, owns: ['other/**'] },
      ],
    }));
    git(repo, 'init', '-q', '-b', 'main');
    write(repo, 'README.md');
    write(repo, 'other/keep.txt');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'feature');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('passes when every committed and working-tree change is owned', () => {
    write(repo, 'pkg/a.mjs');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'owned');
    write(repo, 'shared/one file.txt');
    const res = run('P1', '--base', 'main');
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('OK');
  });

  it('flags a committed path outside owns', () => {
    write(repo, 'pkg/a.mjs');
    write(repo, 'src/App.tsx');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'mixed');
    const res = run('P1', '--base', 'main');
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('src/App.tsx');
    expect(res.stdout).not.toContain('pkg/a.mjs');
  });

  it('flags untracked, staged and modified paths outside owns, names with spaces included', () => {
    write(repo, 'loose dir/new file.txt');
    write(repo, 'README.md', 'changed\n');
    write(repo, 'other/staged.txt');
    git(repo, 'add', 'other/staged.txt');
    const res = run('P1', '--base', 'main');
    expect(res.status).toBe(1);
    for (const p of ['loose dir/new file.txt', 'README.md', 'other/staged.txt']) expect(res.stdout).toContain(p);
  });

  it('flags the old path of a file renamed into owns', () => {
    fs.mkdirSync(path.join(repo, 'pkg'));
    git(repo, 'mv', 'other/keep.txt', 'pkg/keep.txt');
    git(repo, 'commit', '-q', '-m', 'move');
    const res = run('P1', '--base', 'main');
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('other/keep.txt');
  });

  it('only counts changes since the merge base with the base ref', () => {
    git(repo, 'checkout', '-q', 'main');
    write(repo, 'src/on-main.ts');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'main moves on');
    git(repo, 'checkout', '-q', 'feature');
    write(repo, 'pkg/b.mjs');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'owned');
    expect(run('P1', '--base', 'main').status).toBe(0);
  });

  it('fails when two packages of the same wave own the same path', () => {
    fs.writeFileSync(planFile, JSON.stringify({ packages: [{ id: 'P1', wave: 1, owns: ['pkg/**', 'plan.json'] }, { id: 'P2', wave: 1, owns: ['pkg/x.mjs'] }] }));
    const res = run('P1', '--base', 'main');
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('pkg/x.mjs');
  });

  it('exits 2 on usage errors', () => {
    expect(run('NOPE', '--base', 'main').status).toBe(2);
    expect(run('P1').status).toBe(2);
    expect(run('P1', '--base', 'no-such-ref').status).toBe(2);
  });
});

describe('lint-count.mjs', () => {
  it('counts ESLint errors and leaves warnings out', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint count '));
    try {
      write(dir, 'eslint.config.mjs', "export default [{ files: ['src/**/*.js'], rules: { 'no-undef': 'error', 'no-unused-vars': 'warn' } }];\n");
      write(dir, 'src/a.js', 'const unused = 1;\nmissingOne();\nmissingTwo();\n');
      write(dir, 'src/b.js', 'export const fine = 1;\n');
      expect(await countLintErrors({ cwd: dir, patterns: ['src'] })).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
