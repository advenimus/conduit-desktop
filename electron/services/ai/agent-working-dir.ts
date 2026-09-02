/**
 * Resolve the working directory for a CLI agent session.
 *
 * Priority:
 * 1. Explicit cwd (if it exists)
 * 2. Settings default_working_directory (if set and exists)
 * 3. Auto-created {dataDir}/agent/{engineType}
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EngineType } from './engines/engine.js';

export function agentDirPath(dataDir: string, engineType: EngineType): string {
  return path.join(dataDir, 'agent', engineType);
}

export function resolveAgentWorkingDir(opts: {
  engineType: EngineType;
  explicitCwd?: string | null;
  defaultWorkingDirectory?: string | null;
  dataDir: string;
  exists?: (p: string) => boolean;
  mkdir?: (p: string) => void;
}): { cwd: string; usedManagedAgentDir: boolean } {
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const mkdir =
    opts.mkdir ??
    ((p: string) => {
      fs.mkdirSync(p, { recursive: true });
    });

  if (opts.explicitCwd && exists(opts.explicitCwd)) {
    return { cwd: opts.explicitCwd, usedManagedAgentDir: false };
  }

  if (opts.defaultWorkingDirectory && exists(opts.defaultWorkingDirectory)) {
    return { cwd: opts.defaultWorkingDirectory, usedManagedAgentDir: false };
  }

  const dir = agentDirPath(opts.dataDir, opts.engineType);
  mkdir(dir);
  return { cwd: dir, usedManagedAgentDir: true };
}
