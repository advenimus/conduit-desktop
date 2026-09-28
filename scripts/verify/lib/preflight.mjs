// Checks that fail fast with a clear message before anything is built or launched.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO } from './run-context.mjs';
import { runCommand } from './proc.mjs';
import { findPsql } from './supabase-stack.mjs';
import { electronBinary } from './launcher.mjs';

const MIN_NODE_MAJOR = 20;

async function dockerRunning() {
  const res = await runCommand('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true, timeoutMs: 30_000, label: 'docker info' })
    .catch((err) => ({ code: 1, stderr: err.message }));
  if (res.code !== 0) throw new Error('Docker is not running (local Supabase needs it). Start Docker Desktop and rerun.');
  return res.stdout.trim();
}

function resolvable(fromFile, specifier) {
  try {
    createRequire(fromFile).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/** Returns a list of "name: detail" lines; throws on the first hard problem. */
export async function preflight() {
  const notes = [];
  if (process.platform === 'win32') throw new Error('The verify harness runs on macOS and Linux only (Unix sockets under /tmp)');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) throw new Error(`Node ${MIN_NODE_MAJOR}+ is required (found ${process.versions.node})`);
  notes.push(`node: ${process.versions.node}`);
  notes.push(`docker: ${await dockerRunning()}`);
  notes.push(`psql: ${await findPsql()}`);
  const electron = electronBinary();
  if (!fs.existsSync(electron)) throw new Error(`Electron binary missing at ${electron}. Run npm install.`);
  notes.push(`electron: ${path.relative(REPO, electron)}`);
  if (!resolvable(path.join(REPO, 'package.json'), 'playwright-core')) {
    throw new Error('playwright-core is not installed. Run: npm install -D playwright-core --ignore-scripts');
  }
  if (!resolvable(path.join(REPO, 'mcp', 'package.json'), '@modelcontextprotocol/sdk/client/index.js')) {
    throw new Error('@modelcontextprotocol/sdk is not resolvable from mcp/. Run npm install in the repo and in mcp/.');
  }
  return notes;
}
