// Child process helpers: bounded one-shot commands and background servers in their own process group.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { redact } from './redact.mjs';

const OUTPUT_CAP = 4 * 1024 * 1024;

export function tail(text, lines = 30) {
  return String(text ?? '').split('\n').slice(-lines).join('\n');
}

export function tailFile(file, lines = 40) {
  try {
    return tail(fs.readFileSync(file, 'utf8'), lines);
  } catch {
    return '';
  }
}

function appendLog(logFile, chunk) {
  if (logFile) fs.appendFileSync(logFile, redact(chunk.toString()));
}

/**
 * Runs a command to completion. Resolves {code, stdout, stderr}; rejects on a non-zero exit (unless
 * allowFailure), a spawn error or the timeout. Output is copied, redacted, to logFile when given.
 */
export function runCommand(cmd, args, opts = {}) {
  const { cwd, env, logFile, timeoutMs = 120_000, input, allowFailure = false, label = cmd } = opts;
  return new Promise((resolve, reject) => {
    if (logFile) fs.appendFileSync(logFile, `\n$ ${label} ${args.map((a) => redact(a)).join(' ')}\n`);
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`${label} timed out after ${timeoutMs} ms\n${tail(redact(stderr || stdout))}`));
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      if (stdout.length < OUTPUT_CAP) stdout += c;
      appendLog(logFile, c);
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < OUTPUT_CAP) stderr += c;
      appendLog(logFile, c);
    });
    child.once('error', (err) => finish(reject, new Error(`${label} could not start: ${err.message}`)));
    child.once('close', (code, signal) => {
      if (code === 0 || allowFailure) {
        finish(resolve, { code, signal, stdout, stderr });
        return;
      }
      const why = signal ? `signal ${signal}` : `exit code ${code}`;
      finish(reject, new Error(`${label} failed (${why})\n${tail(redact(stderr || stdout))}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/** Starts a long-running process in its own process group so stopProcessGroup reaches its children. */
export function startBackground(cmd, args, { cwd, env, logFile }) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  return child;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

export async function stopProcessGroup(child, { graceMs = 5_000 } = {}) {
  const pid = child?.pid;
  if (!pid || !alive(pid)) return 'not running';
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return 'stopped';
    await new Promise((r) => setTimeout(r, 100));
  }
  signalGroup(pid, 'SIGKILL');
  return 'killed';
}

/** PIDs whose command line mentions `needle` (other than this process). */
export async function pidsMentioning(needle) {
  if (process.platform === 'win32') return [];
  const { stdout } = await runCommand('ps', ['-axww', '-o', 'pid=,command='], { label: 'ps' });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(needle))
    .map((line) => ({ pid: Number(line.split(/\s+/, 1)[0]), command: line.slice(line.indexOf(' ') + 1) }))
    .filter((p) => Number.isInteger(p.pid) && p.pid !== process.pid);
}
