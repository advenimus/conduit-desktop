// Builds the main process and MCP server for a run, and serves the renderer from a private Vite.

import fs from 'node:fs';
import path from 'node:path';
import { REPO, VERIFY_DIR } from './run-context.mjs';
import { runCommand, startBackground, stopProcessGroup, tailFile } from './proc.mjs';

const TSC = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
const VITE = path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
const VITE_READY_TIMEOUT_MS = 90_000;

function buildEnv() {
  return { ...process.env, CONDUIT_ENV: 'preview' };
}

function removeCompiledTests(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === '__tests__') fs.rmSync(full, { recursive: true, force: true });
    else removeCompiledTests(full);
  }
}

/**
 * Compiles electron/ into .verify/<runId>/dist-electron (inside the repo so node_modules resolve)
 * and mcp/ into mcp/dist, the path the MCP client and the app use. Returns the main.js path.
 */
export async function buildForRun(run) {
  const outDir = path.join(run.runDir, 'dist-electron');
  const logFile = run.logPath('build.log');
  run.onCleanup(run.keep ? 'keep compiled main process (--keep)' : 'remove compiled main process', () => {
    if (!run.keep) fs.rmSync(outDir, { recursive: true, force: true });
  });
  await runCommand(process.execPath, [TSC, '-p', path.join(REPO, 'electron', 'tsconfig.json'), '--outDir', outDir], {
    cwd: REPO,
    env: buildEnv(),
    logFile,
    timeoutMs: 5 * 60_000,
    label: 'tsc electron',
  });
  // tsc emits the unit tests too; vitest must never pick up copies from a run directory.
  removeCompiledTests(outDir);
  await runCommand('npx', ['tsc'], { cwd: path.join(REPO, 'mcp'), env: buildEnv(), logFile, timeoutMs: 5 * 60_000, label: 'tsc mcp' });
  // Dev builds read tray icons and window icons from <dist-electron>/../resources and ../build.
  for (const dir of ['resources', 'build']) {
    const link = path.join(run.runDir, dir);
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(REPO, dir), link, 'dir');
  }
  const mainJs = path.join(outDir, 'main.js');
  if (!fs.existsSync(mainJs)) throw new Error(`Build finished but ${mainJs} is missing`);
  return mainJs;
}

// The dependency scan runs on every run (optimizeDeps.force): a kept cache skips it, so an import added
// since the last run is first met mid-scenario, and Vite then reloads the page and drops the app's state.
function writeViteConfig(run, port) {
  const file = path.join(run.runDir, 'vite.config.mjs');
  const cacheDir = path.join(VERIFY_DIR, 'vite-cache');
  fs.writeFileSync(file, `import { mergeConfig } from 'vite';
import base from ${JSON.stringify(path.join(REPO, 'vite.config.ts'))};

export default mergeConfig(base, {
  cacheDir: ${JSON.stringify(cacheDir)},
  optimizeDeps: { force: true },
  server: { port: ${port}, strictPort: true, watch: { ignored: ['**/.verify/**'] } },
});
`);
  return file;
}

async function waitForHttp(url, child, logFile) {
  const deadline = Date.now() + VITE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited with code ${child.exitCode}\n${tailFile(logFile)}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Vite did not answer on ${url} within ${VITE_READY_TIMEOUT_MS / 1000} s\n${tailFile(logFile)}`);
}

/**
 * Serves the renderer on `port` (never 1420, which the user's own dev app may hold). Uses its own
 * dependency cache so it cannot disturb a dev server running from the same worktree.
 */
export async function startVite(run, port) {
  const logFile = run.logPath('vite.log');
  const config = writeViteConfig(run, port);
  const child = startBackground(process.execPath, [VITE, '--config', config, '--port', String(port), '--strictPort'], {
    cwd: REPO,
    env: buildEnv(),
    logFile,
  });
  const stop = run.onCleanup('stop Vite', () => stopProcessGroup(child));
  const url = `http://localhost:${port}`;
  try {
    await waitForHttp(url, child, logFile);
  } catch (err) {
    await stop();
    throw err;
  }
  return { url, port, pid: child.pid, stop };
}
