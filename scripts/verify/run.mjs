#!/usr/bin/env node
// Live verify runner: node scripts/verify/run.mjs [all|<suite>...] [--only <scenarioId>] [--keep]
// See scripts/verify/README.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildForRun, startVite } from './lib/app.mjs';
import { scenarioContext } from './lib/context.mjs';
import { preflight } from './lib/preflight.mjs';
import { pidsMentioning } from './lib/proc.mjs';
import { createReporter } from './lib/report.mjs';
import { createRunContext, freePort, installSignalHandlers } from './lib/run-context.mjs';
import { deleteTestUsers, ensureLocalSupabase, sweepStaleTestUsers } from './lib/supabase.mjs';

const SUITES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'suites');
const USAGE = `Usage: node scripts/verify/run.mjs [all|<suite>...] [--only <scenarioId>] [--keep]

  all            every suite in scripts/verify/suites (default)
  <suite>        one or more suite ids, e.g. smoke, sync, mcp
  --only <id>    run only the scenario with this id (repeatable)
  --keep         keep the /tmp/cv-<id> device roots for inspection`;

export function parseArgs(argv) {
  const opts = { suites: [], only: [], keep: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--only') {
      const id = argv[++i];
      if (!id || id.startsWith('--')) throw new Error('--only needs a scenario id');
      opts.only.push(id);
    } else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else opts.suites.push(arg);
  }
  if (opts.suites.length === 0) opts.suites.push('all');
  return opts;
}

function validateSuite(suite, file) {
  const ok = suite && typeof suite.id === 'string' && typeof suite.title === 'string' && Array.isArray(suite.scenarios) &&
    suite.scenarios.every((s) => typeof s.id === 'string' && typeof s.title === 'string' && typeof s.run === 'function');
  if (!ok) throw new Error(`${file} must export default {id, title, scenarios: [{id, title, run(ctx)}]}`);
  return suite;
}

async function loadSuites() {
  const files = fs.readdirSync(SUITES_DIR).filter((f) => f.endsWith('.mjs')).sort();
  const suites = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(SUITES_DIR, file)).href);
    suites.push(validateSuite(mod.default, file));
  }
  return suites;
}

function selectSuites(available, opts) {
  const ids = available.map((s) => s.id);
  const wanted = opts.suites.includes('all') ? ids : opts.suites;
  const missing = wanted.filter((id) => !ids.includes(id));
  if (missing.length > 0) throw new Error(`No suite named ${missing.join(', ')}. Available: ${ids.join(', ') || '(none)'}`);
  const selected = available
    .filter((s) => wanted.includes(s.id))
    .map((s) => ({ ...s, scenarios: opts.only.length > 0 ? s.scenarios.filter((sc) => opts.only.includes(sc.id)) : s.scenarios }))
    .filter((s) => s.scenarios.length > 0);
  if (selected.length === 0) throw new Error(`No scenario matched --only ${opts.only.join(', ')}`);
  return selected;
}

async function leftoverProcesses(run) {
  const find = async () => [...(await pidsMentioning(run.tmpRoot)), ...(await pidsMentioning(run.runDir))];
  const deadline = Date.now() + 8_000;
  let found = await find();
  while (found.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    found = await find();
  }
  for (const p of found) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      // Gone between ps and kill.
    }
  }
  return found.map((p) => `${p.pid} ${p.command.slice(0, 160)}`);
}

function createFinisher(run, reporter) {
  let finishing = null;
  return (reason) => {
    finishing ??= (async () => {
      if (reason) reporter.log(`stopping: ${reason}`);
      const t0 = Date.now();
      const failures = await run.runCleanup();
      const leftovers = await leftoverProcesses(run).catch((err) => [`process check failed: ${err.message}`]);
      for (const l of leftovers) reporter.log(`   leftover process killed: ${l}`);
      reporter.setCleanup({ durationMs: Date.now() - t0, failures, leftoverProcesses: leftovers, keptRoots: run.keep ? run.tmpRoot : null });
      return reporter.summary();
    })();
    return finishing;
  };
}

async function runScenarios(suites, { run, env, reporter, isAborted }) {
  for (const suite of suites) {
    for (const sc of suite.scenarios) {
      if (isAborted()) return;
      let close = null;
      let devices = () => [];
      await reporter.scenario(suite, sc, async (step) => {
        const scoped = scenarioContext({ run, env, step, scenario: `${suite.id}/${sc.id}` });
        close = scoped.close;
        devices = scoped.ctx.liveDevices;
        await sc.run(scoped.ctx);
      }, () => devices());
      await close?.().catch((err) => reporter.log(`   closing devices failed: ${err.message}`));
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const suites = selectSuites(await loadSuites(), opts);
  const run = createRunContext({ keep: opts.keep });
  const reporter = createReporter(run);
  const finish = createFinisher(run, reporter);
  let aborted = false;
  installSignalHandlers(run, async (signal) => {
    aborted = true;
    await finish(`received ${signal}`);
  });
  run.onCleanup('delete test users', deleteTestUsers);
  reporter.log(`run ${run.runId}: ${suites.map((s) => `${s.id}(${s.scenarios.map((sc) => sc.id).join(',')})`).join(' ')}`);
  reporter.log(`artifacts: ${run.runDir}`);

  try {
    const notes = await reporter.phase('preflight', preflight);
    for (const n of notes) reporter.log(`   ${n}`);
    const sbLog = (m) => reporter.log(`   ${m}`);
    sbLog.file = (name) => run.logPath(name);
    await reporter.phase('supabase', async () => {
      await ensureLocalSupabase(sbLog);
      const swept = await sweepStaleTestUsers();
      if (swept > 0) sbLog(`removed ${swept} stale verify users from earlier runs`);
    });
    const mainJs = await reporter.phase('build', () => buildForRun(run));
    const vite = await reporter.phase('vite', async () => startVite(run, await freePort()));
    reporter.log(`   renderer served at ${vite.url}`);
    await runScenarios(suites, { run, env: { mainJs, devServerUrl: vite.url }, reporter, isAborted: () => aborted });
  } catch {
    // The failed phase is already in the report; cleanup still runs.
  }
  return finish(aborted ? 'interrupted' : null);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[verify] ${err.message}`);
      process.exit(2);
    },
  );
}
