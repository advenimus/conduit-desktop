#!/usr/bin/env node
// Usage: node scripts/redesign/check-owns.mjs <PACKAGE-ID> --base <ref> [--plan <file>]
//
// Fails (exit 1) when a path changed since the merge base with <ref> lies outside the package's
// `owns` in work-packages.json, or when two packages of the package's wave own the same path
// (docs/VISUAL_REDESIGN.md section 10, rule 1). Changed paths are the union of
// `git diff --name-only $(git merge-base HEAD <ref>)...HEAD` and `git status --porcelain`, with
// renames split into their two paths and untracked files listed one by one. Usage errors exit 2.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLAN = path.join(SCRIPT_DIR, 'work-packages.json');
const DIR_SUFFIX = '/**';

class UsageError extends Error {}

/** An owns pattern is a repo-relative path or `<dir>/**`; anything else is a plan error. */
export function validatePattern(pattern) {
  const body = pattern.endsWith(DIR_SUFFIX) ? pattern.slice(0, -DIR_SUFFIX.length) : pattern;
  const bad = typeof pattern !== 'string' || body === '' || /[*?[\]{}\\]/.test(body) || body.startsWith('/') || body.endsWith('/');
  if (bad) throw new Error(`Unsupported owns pattern "${pattern}": use a repo-relative path or <dir>/**`);
}

export function validatePlan(plan) {
  if (!Array.isArray(plan?.packages)) throw new Error('The plan has no "packages" list');
  for (const pkg of plan.packages) {
    if (typeof pkg.id !== 'string' || !Number.isInteger(pkg.wave) || !Array.isArray(pkg.owns)) {
      throw new Error(`Package ${JSON.stringify(pkg.id)} needs an id, a whole-number wave and an owns list`);
    }
    pkg.owns.forEach(validatePattern);
  }
}

export function loadPlan(file) {
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  validatePlan(plan);
  return plan;
}

const isDir = (pattern) => pattern.endsWith(DIR_SUFFIX);
const dirOf = (pattern) => pattern.slice(0, -DIR_SUFFIX.length);
const under = (file, dir) => file.startsWith(`${dir}/`);

function patternMatches(pattern, file) {
  return isDir(pattern) ? under(file, dirOf(pattern)) : file === pattern;
}

export function ownsPath(patterns, file) {
  return patterns.some((p) => patternMatches(p, file));
}

export function patternsOverlap(a, b) {
  if (isDir(a) && isDir(b)) {
    const [da, db] = [dirOf(a), dirOf(b)];
    return da === db || under(da, db) || under(db, da);
  }
  if (isDir(a)) return patternMatches(a, b);
  if (isDir(b)) return patternMatches(b, a);
  return a === b;
}

/** Pairs of packages in `wave` whose owns patterns share a path: [{a, b, patternA, patternB}]. */
export function waveOverlaps(plan, wave) {
  const pkgs = plan.packages.filter((p) => p.wave === wave);
  return pkgs.flatMap((pa, i) => pkgs.slice(i + 1).flatMap((pb) =>
    pa.owns.flatMap((patternA) => pb.owns.filter((patternB) => patternsOverlap(patternA, patternB)).map((patternB) => ({ a: pa.id, b: pb.id, patternA, patternB }))),
  ));
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const detail = String(err.stderr ?? err.message).trim();
    throw new UsageError(`git ${args.join(' ')} failed: ${detail}`);
  }
}

const splitZ = (out) => out.split('\0').filter((s) => s !== '');

/** Every path changed on this branch since its merge base with `base`, committed or not, sorted. */
export function changedPaths(cwd, base) {
  const mergeBase = git(cwd, ['merge-base', 'HEAD', base]).trim();
  const committed = splitZ(git(cwd, ['diff', '--name-only', '--no-renames', '-z', `${mergeBase}...HEAD`]));
  // Porcelain v1 entries are "XY <path>"; with --no-renames every entry holds exactly one path.
  const working = splitZ(git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])).map((e) => e.slice(3));
  return { mergeBase, paths: [...new Set([...committed, ...working])].sort() };
}

export function checkOwns({ plan, id, base, cwd }) {
  const pkg = plan.packages.find((p) => p.id === id);
  if (!pkg) throw new UsageError(`Unknown package "${id}". Known: ${plan.packages.map((p) => p.id).join(', ')}`);
  const { mergeBase, paths } = changedPaths(cwd, base);
  return {
    pkg,
    mergeBase,
    changed: paths,
    outside: paths.filter((p) => !ownsPath(pkg.owns, p)),
    overlaps: waveOverlaps(plan, pkg.wave),
  };
}

export function parseArgs(argv) {
  const out = { id: null, base: null, plan: DEFAULT_PLAN };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base' || arg === '--plan') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      out[arg.slice(2)] = value;
    } else if (arg.startsWith('--')) {
      throw new UsageError(`Unknown option ${arg}`);
    } else if (out.id === null) {
      out.id = arg;
    } else {
      throw new UsageError(`Unexpected argument ${arg}`);
    }
  }
  if (!out.id || !out.base) throw new UsageError('Usage: check-owns.mjs <PACKAGE-ID> --base <ref> [--plan <file>]');
  return out;
}

function report({ pkg, mergeBase, changed, outside, overlaps }, base) {
  const lines = [`check-owns ${pkg.id}: ${changed.length} changed path(s) since ${mergeBase.slice(0, 10)} (merge base with ${base})`];
  if (outside.length > 0) lines.push(`FAIL: ${outside.length} path(s) outside the owns of ${pkg.id}:`, ...outside.map((p) => `  ${p}`));
  if (overlaps.length > 0) {
    lines.push(`FAIL: packages of wave ${pkg.wave} own the same paths:`, ...overlaps.map((o) => `  ${o.a} ${o.patternA} and ${o.b} ${o.patternB}`));
  }
  if (outside.length === 0 && overlaps.length === 0) lines.push(`OK: every changed path is owned by ${pkg.id}`);
  return lines.join('\n');
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const plan = loadPlan(path.resolve(args.plan));
    const cwd = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    const result = checkOwns({ plan, id: args.id, base: args.base, cwd });
    console.log(report(result, args.base));
    process.exitCode = result.outside.length === 0 && result.overlaps.length === 0 ? 0 : 1;
  } catch (err) {
    console.error(err instanceof UsageError ? err.message : `check-owns: ${err.stack ?? err}`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
