#!/usr/bin/env node
// Desktop footage for the 0.18 promo video: one quiet device per scene group in local mode with the
// fictional "Acme Infrastructure" vault, 1440x900 at scale 2, written to the promo footage folder with
// a shots.json of the elements a viewer should look at. Never touches real vaults, accounts or data.
// Usage: node scripts/verify/capture-promo.mjs [--scene s1,s3,...] [--out <dir>]

import path from 'node:path';
import { buildForRun, startVite } from './lib/app.mjs';
import { scenarioContext } from './lib/context.mjs';
import { createRunContext, freePort, installSignalHandlers } from './lib/run-context.mjs';
import { deleteTestUsers } from './lib/supabase.mjs';
import { createRecorder } from './lib/promo-capture.mjs';
import { SCENES } from './lib/promo-scenes.mjs';

const DEFAULT_OUT = '/Volumes/SSD Storage/Github/Repos/conduit-promo-0.18/footage/desktop';

function parseArgs(argv) {
  const arg = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  const scenes = (arg('--scene') ?? Object.keys(SCENES).join(',')).split(',');
  const unknown = scenes.filter((s) => !SCENES[s]);
  if (unknown.length > 0) throw new Error(`unknown scene ${unknown.join(', ')}; use ${Object.keys(SCENES).join(', ')}`);
  return { scenes, out: arg('--out') ?? DEFAULT_OUT };
}

async function main() {
  const { scenes, out } = parseArgs(process.argv.slice(2));
  const run = createRunContext();
  installSignalHandlers(run);
  run.onCleanup('delete test users', deleteTestUsers);
  const log = (m) => console.log(`[promo] ${m}`);
  log.file = (name) => run.logPath(name);
  const rec = createRecorder(path.resolve(out));
  const failures = [];
  try {
    const mainJs = await buildForRun(run);
    const vite = await startVite(run, await freePort());
    const { ctx, close } = scenarioContext({ run, env: { mainJs, devServerUrl: vite.url }, step: log });
    try {
      for (const id of scenes) {
        try {
          await SCENES[id](ctx, rec);
        } catch (err) {
          failures.push(`${id}: ${err.message.split('\n')[0]}`);
          console.log(`[promo] ${id} failed: ${err.stack}`);
        }
      }
    } finally {
      await close();
    }
  } catch (err) {
    failures.push(`run stopped: ${err.message}`);
  } finally {
    await run.runCleanup();
  }
  rec.writeManifest();
  log(`${rec.shots.length} shot(s) in ${out}, ${failures.length} failure(s)`);
  for (const f of failures) log(`  FAILED ${f}`);
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[promo] ${err.message}`);
    process.exit(2);
  },
);
