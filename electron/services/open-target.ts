import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type OpenTarget =
  | { kind: 'url'; url: string }
  | { kind: 'path'; path: string };

export interface OpenTargetDeps {
  openExternal: (url: string) => Promise<void>;
  openPath: (target: string) => Promise<string>;
  showItemInFolder: (target: string) => void;
  exists: (target: string) => boolean;
  homeDir?: string;
}

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

// Agent output is untrusted and an OSC 8 label can hide its real target, so these are revealed, never run.
const EXECUTABLE_EXTENSIONS = new Set([
  '.app', '.command', '.sh', '.exe', '.bat', '.cmd', '.msi', '.scr', '.jar', '.ps1', '.dmg',
]);

const LINE_COL_SUFFIX = /:\d+(?::\d+)?$/;

export function classifyTarget(raw: string, homeDir: string = os.homedir()): OpenTarget | null {
  const text = raw.trim();
  if (!text) return null;

  if (text === '~' || text.startsWith('~/')) {
    return { kind: 'path', path: path.join(homeDir, text.slice(1).replace(LINE_COL_SUFFIX, '')) };
  }

  if (path.isAbsolute(text)) {
    return { kind: 'path', path: text.replace(LINE_COL_SUFFIX, '') };
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }

  if (EXTERNAL_PROTOCOLS.has(parsed.protocol)) return { kind: 'url', url: parsed.href };
  if (parsed.protocol === 'file:') {
    try {
      return { kind: 'path', path: fileURLToPath(parsed) };
    } catch {
      return null;
    }
  }
  return null;
}

export async function openTarget(raw: string, deps: OpenTargetDeps): Promise<void> {
  const target = classifyTarget(raw, deps.homeDir);
  if (!target) throw new Error(`Can't open this link: ${raw.slice(0, 200)}`);

  if (target.kind === 'url') {
    await deps.openExternal(target.url);
    return;
  }

  if (!deps.exists(target.path)) throw new Error(`Path does not exist: ${target.path}`);

  if (EXECUTABLE_EXTENSIONS.has(path.extname(target.path).toLowerCase())) {
    deps.showItemInFolder(target.path);
    return;
  }

  const errMsg = await deps.openPath(target.path);
  if (errMsg) throw new Error(errMsg);
}
