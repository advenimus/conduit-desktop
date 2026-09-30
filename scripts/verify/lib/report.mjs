// Timestamped progress, per-scenario results, failure artifacts and the final summary.

import fs from 'node:fs';
import path from 'node:path';
import { tailFile } from './proc.mjs';
import { redact } from './redact.mjs';
import { screenshot } from './ui.mjs';

const LOG_TAIL_LINES = 40;

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str.slice(0, n) : str + ' '.repeat(n - str.length);
}

function secs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function createReporter(run) {
  const started = Date.now();
  const runLog = run.logPath('run.log');
  const results = { runId: run.runId, runDir: run.runDir, startedAt: new Date(started).toISOString(), phases: [], scenarios: [], cleanup: null };

  function write(line) {
    const stamped = `[+${secs(Date.now() - started).padStart(7)}] ${redact(line)}`;
    process.stdout.write(`${stamped}\n`);
    fs.appendFileSync(runLog, `${stamped}\n`);
  }

  function save() {
    fs.writeFileSync(run.resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  }

  async function phase(name, fn) {
    const t0 = Date.now();
    write(`== ${name}`);
    try {
      const value = await fn();
      results.phases.push({ name, status: 'pass', durationMs: Date.now() - t0 });
      write(`== ${name}: done in ${secs(Date.now() - t0)}`);
      return value;
    } catch (err) {
      results.phases.push({ name, status: 'fail', durationMs: Date.now() - t0, error: redact(err?.message ?? err) });
      write(`== ${name}: FAILED after ${secs(Date.now() - t0)}: ${err?.message ?? err}`);
      throw err;
    } finally {
      save();
    }
  }

  async function captureFailure(scenarioKey, devices) {
    const artifacts = [];
    for (const device of devices) {
      const entry = { device: device.name, screenshot: null, mainLogTail: tailFile(device.mainLog, LOG_TAIL_LINES), rendererLogTail: tailFile(device.rendererLog, LOG_TAIL_LINES) };
      try {
        entry.screenshot = await screenshot(device, `FAIL-${scenarioKey}`);
      } catch (err) {
        entry.screenshot = `unavailable: ${err.message}`;
      }
      write(`   [${device.name}] screenshot: ${entry.screenshot}`);
      write(`   [${device.name}] main log tail (${path.relative(run.runDir, device.mainLog)}):\n${entry.mainLogTail.replace(/^/gm, '      | ')}`);
      artifacts.push(entry);
    }
    return artifacts;
  }

  /** Runs one scenario; never throws. `liveDevices()` lists devices to capture on failure. */
  async function scenario(suite, sc, fn, liveDevices) {
    const key = `${suite.id}/${sc.id}`;
    const t0 = Date.now();
    const record = { suite: suite.id, scenario: sc.id, title: sc.title, status: 'running', durationMs: 0, steps: [], error: null, failure: null };
    results.scenarios.push(record);
    write(`-> ${key}: ${sc.title}`);
    const step = (msg) => {
      record.steps.push({ atMs: Date.now() - t0, msg: redact(msg) });
      write(`   . ${msg}`);
    };
    try {
      await fn(step);
      record.status = 'pass';
    } catch (err) {
      record.status = 'fail';
      record.error = redact(err?.stack ?? err);
      write(`   FAIL ${key}: ${err?.message ?? err}`);
      record.failure = await captureFailure(key.replace('/', '-'), liveDevices());
    }
    record.durationMs = Date.now() - t0;
    write(`<- ${key}: ${record.status.toUpperCase()} in ${secs(record.durationMs)}`);
    save();
    return record.status === 'pass';
  }

  function setCleanup(info) {
    results.cleanup = info;
    save();
  }

  /** Prints the table, writes results.json, returns the process exit code. */
  function summary() {
    results.finishedAt = new Date().toISOString();
    results.durationMs = Date.now() - started;
    const failed = results.scenarios.filter((s) => s.status !== 'pass').length + results.phases.filter((p) => p.status === 'fail').length;
    const cleanupProblems = (results.cleanup?.failures?.length ?? 0) + (results.cleanup?.leftoverProcesses?.length ?? 0);
    results.status = failed === 0 && cleanupProblems === 0 ? 'pass' : 'fail';
    save();
    const lines = ['', `${pad('SCENARIO', 44)} ${pad('STATUS', 7)} TIME`];
    for (const p of results.phases) lines.push(`${pad(`[phase] ${p.name}`, 44)} ${pad(p.status.toUpperCase(), 7)} ${secs(p.durationMs)}`);
    for (const s of results.scenarios) lines.push(`${pad(`${s.suite}/${s.scenario}`, 44)} ${pad(s.status.toUpperCase(), 7)} ${secs(s.durationMs)}`);
    if (results.cleanup) {
      lines.push(`${pad('[cleanup]', 44)} ${pad(cleanupProblems === 0 ? 'PASS' : 'FAIL', 7)} ${secs(results.cleanup.durationMs ?? 0)}`);
    }
    lines.push('', `RESULT: ${results.status.toUpperCase()} in ${secs(results.durationMs)}  (${path.relative(process.cwd(), run.resultsPath)})`);
    for (const line of lines) write(line);
    return results.status === 'pass' ? 0 : 1;
  }

  return { log: write, phase, scenario, setCleanup, summary, results };
}
