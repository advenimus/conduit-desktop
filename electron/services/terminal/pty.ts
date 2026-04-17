/**
 * Local shell creation via node-pty.
 *
 * Port of crates/conduit-terminal/src/local_shell.rs
 */

import * as nodePty from 'node-pty';
import os from 'node:os';

export type ShellType = 'default' | 'bash' | 'zsh' | 'powershell' | 'cmd';

export interface PtyOptions {
  shellType?: ShellType;   // used when command is NOT provided
  command?: string;        // if set, spawn this instead of a shell
  args?: string[];
  cwd?: string;            // if set, use instead of os.homedir()
}

export interface LocalPty {
  pty: nodePty.IPty;
  kill(): void;
}

/** Resolve the shell executable and args from a ShellType. */
function resolveShell(shellType: ShellType): { file: string; args: string[] } {
  const isWindows = os.platform() === 'win32';

  switch (shellType) {
    case 'bash':
      return { file: 'bash', args: [] };
    case 'zsh':
      return { file: 'zsh', args: [] };
    case 'powershell':
      return { file: 'powershell.exe', args: ['-NoLogo'] };
    case 'cmd':
      return { file: 'cmd.exe', args: [] };
    case 'default':
    default:
      if (isWindows) {
        return { file: 'powershell.exe', args: ['-NoLogo'] };
      }
      // Use $SHELL or fall back to bash
      return { file: process.env.SHELL || 'bash', args: [] };
  }
}

/** Parse a string into a ShellType (matches Rust ShellType::from_str). */
export function parseShellType(s?: string | null): ShellType {
  if (!s) return 'default';
  switch (s.toLowerCase()) {
    case 'bash':
      return 'bash';
    case 'zsh':
      return 'zsh';
    case 'powershell':
    case 'pwsh':
      return 'powershell';
    case 'cmd':
      return 'cmd';
    default:
      return 'default';
  }
}

/**
 * Spawn a local PTY process.
 *
 * When `opts.command` is provided, it is spawned directly (for CLI agents).
 * Otherwise a shell is spawned based on `opts.shellType`.
 *
 * @param opts  Options controlling what to spawn and where
 * @param cols  Initial terminal columns (default 80)
 * @param rows  Initial terminal rows   (default 24)
 */
export function createLocalPty(
  opts: PtyOptions = {},
  cols = 80,
  rows = 24,
): LocalPty {
  const file = opts.command ?? resolveShell(opts.shellType ?? 'default').file;
  const args = opts.command ? (opts.args ?? []) : resolveShell(opts.shellType ?? 'default').args;
  const cwd = opts.cwd ?? os.homedir();

  const pty = nodePty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>,
  });

  return {
    pty,
    kill() {
      pty.kill();
    },
  };
}
