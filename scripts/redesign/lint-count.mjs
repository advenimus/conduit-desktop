#!/usr/bin/env node
// Prints the number of ESLint errors in src (warnings are not counted). ESLint 10 ships no
// line-per-error formatter, so the count comes from the Node API. Compare it with the count
// printed on the wave base (docs/VISUAL_REDESIGN.md section 10, rule 5).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function countLintErrors({ cwd = REPO_ROOT, patterns = ['src'] } = {}) {
  const eslint = new ESLint({ cwd });
  const results = await eslint.lintFiles(patterns);
  return results.reduce((n, r) => n + r.errorCount, 0);
}

async function main() {
  try {
    console.log(await countLintErrors());
  } catch (err) {
    console.error(`lint-count: ${err.stack ?? err}`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
