#!/usr/bin/env node
// One-off screenshot pass for the spacing work: one quiet device per mode, driven straight through
// every screen, no scenarios and no checks. Writes .verify/spacing/<set>/<mode>-<nn>-<name>.png and
// INDEX.md. Usage: node scripts/verify/capture-spacing.mjs <before|after> [--mode dark|light]

import fs from 'node:fs';
import path from 'node:path';
import { buildForRun, startVite } from './lib/app.mjs';
import { scenarioContext } from './lib/context.mjs';
import { createRunContext, freePort, installSignalHandlers, VERIFY_DIR } from './lib/run-context.mjs';
import { deleteTestUsers, ensureLocalSupabase } from './lib/supabase.mjs';
import { startTestSite } from './lib/restyle-data.mjs';
import { captureMode } from './lib/spacing-screens.mjs';

const SETS = Object.freeze(['before', 'after']);
const MODES = Object.freeze(['dark', 'light']);

function parseArgs(argv) {
  const set = argv[0];
  if (!SETS.includes(set)) throw new Error('usage: node scripts/verify/capture-spacing.mjs <before|after> [--mode dark|light]');
  const i = argv.indexOf('--mode');
  const modes = i === -1 ? MODES : [argv[i + 1]];
  if (!modes.every((m) => MODES.includes(m))) throw new Error(`--mode must be one of ${MODES.join(', ')}`);
  return { set, modes };
}

function writeIndex(outDir, set, shots, failures) {
  const lines = [
    `# Spacing pass: ${set} screenshots`,
    '',
    `Captured ${new Date().toISOString().slice(0, 10)} with \`node scripts/verify/capture-spacing.mjs ${set}\` on branch \`advenimus/spacing-pass\`.`,
    'One quiet device per mode, signed in as a Pro test user, four recent vaults (CloudWise has automatic unlock on and a Quick Unlock fingerprint).',
    '',
    '| File | Shows |',
    '|---|---|',
    ...shots.map((s) => `| \`${s.file}\` | ${s.what} |`),
  ];
  if (failures.length > 0) lines.push('', '## Not captured', '', ...failures.map((f) => `- ${f}`));
  fs.writeFileSync(path.join(outDir, 'INDEX.md'), `${lines.join('\n')}\n`);
}

async function main() {
  const { set, modes } = parseArgs(process.argv.slice(2));
  const outDir = path.join(VERIFY_DIR, 'spacing', set);
  fs.mkdirSync(outDir, { recursive: true });
  const run = createRunContext();
  installSignalHandlers(run);
  run.onCleanup('delete test users', deleteTestUsers);
  const log = (m) => console.log(`[spacing] ${m}`);
  log.file = (name) => run.logPath(name);
  const shots = [];
  const failures = [];
  try {
    await ensureLocalSupabase(log);
    const mainJs = await buildForRun(run);
    const vite = await startVite(run, await freePort());
    const site = await startTestSite(run);
    const { ctx, close } = scenarioContext({ run, env: { mainJs, devServerUrl: vite.url }, step: log });
    try {
      for (const mode of modes) {
        const res = await captureMode(ctx, { mode, outDir, siteUrl: site.url });
        shots.push(...res.shots);
        failures.push(...res.failures);
      }
    } finally {
      await close();
    }
  } catch (err) {
    failures.push(`run stopped: ${err.message}`);
  } finally {
    await run.runCleanup();
  }
  const kept = shots.filter((s) => fs.existsSync(path.join(outDir, s.file)));
  writeIndex(outDir, set, kept, failures);
  log(`${kept.length} shot(s) in ${path.relative(process.cwd(), outDir)}, ${failures.length} failure(s)`);
  for (const f of failures) log(`  FAILED ${f}`);
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[spacing] ${err.message}`);
    process.exit(2);
  },
);
