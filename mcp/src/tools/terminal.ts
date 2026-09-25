/**
 * Terminal MCP tools.
 *
 * Command execution, output capture, and screen reads happen inside the
 * Conduit app (TerminalManager), which sees the session's raw output stream.
 * Older apps without those IPC requests fall back to terminal-legacy.ts.
 */

import type { ConduitClient } from '../ipc-client.js';
import { textResult } from '../tool-result.js';
import { isUnknownRequest, legacyExecute, legacyReadPane, legacySendKeys } from './terminal-legacy.js';
import { parseKeySequences } from './terminal-text.js';

export { parseKeySequences };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_PANE_LINES = 50;
const MAX_PANE_LINES = 5_000;
const MAX_WAIT_MS = 120_000;
const SHELLS = ['auto', 'posix', 'powershell'] as const;
const NO_OUTPUT = '(no output)';

const HINTS = {
  timed_out:
    'The command is still running. Watch it with terminal_read_pane, answer a prompt with terminal_send_keys, ' +
    'or interrupt it by sending "\\x03". The session accepts new terminal_execute calls once it finishes.',
  not_started:
    'The shell never started the command. The session may be at a prompt that is not a shell ' +
    '(REPL, password prompt, network device CLI) or still busy. The text below is the current screen; ' +
    'use terminal_send_keys with wait_ms to interact with it.',
  interrupted: 'The command was interrupted with Ctrl+C before it finished.',
  session_closed:
    'The session closed while the command was running (e.g. `exit`, or the connection dropped). ' +
    'Call connection_list for current sessions.',
  truncated:
    'Output was too long; the middle was omitted. Re-run with output redirected to a file and read it in parts ' +
    '(e.g. sed -n \'1,200p\' file).',
};

// ---------- Argument validation ----------

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return Math.min(max, Math.max(min, Math.round(value)));
}

// ---------- terminal_execute ----------

export function terminalExecuteDefinition() {
  return {
    name: 'terminal_execute',
    description:
      'Run a shell command in a terminal session and wait for it to finish. Returns a JSON block (exit_code, status, ' +
      'duration) followed by the command output as plain text (stdout and stderr combined, colors removed). ' +
      'Multi-line scripts, heredocs, pipes, quotes, and comments run exactly as written, and state such as `cd` ' +
      'and exported variables persists between calls. Supports POSIX shells (bash, zsh, sh, dash, ash, ksh) and ' +
      'PowerShell. One command runs at a time per session. Avoid pagers and interactive prompts (use --no-pager, ' +
      '| cat, -y); for REPLs, prompts, or full-screen programs use terminal_send_keys and terminal_read_pane. ' +
      'Very long output keeps the beginning and the end.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the connection/session' },
        command: { type: 'string', description: 'Command or multi-line script to run' },
        timeout_ms: {
          type: 'number',
          description:
            `Maximum time to wait in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS}). ` +
            'On timeout the command keeps running and the session stays busy until it finishes or is interrupted.',
          default: DEFAULT_TIMEOUT_MS,
        },
        shell: {
          type: 'string',
          enum: [...SHELLS],
          description:
            'Shell syntax of the session. "auto" (default) detects local shells and treats SSH sessions as POSIX; ' +
            'pass "powershell" for SSH sessions to Windows hosts running PowerShell.',
          default: 'auto',
        },
      },
      required: ['connection_id', 'command'],
    },
  };
}

export async function terminalExecute(client: ConduitClient, args: Record<string, unknown>): Promise<unknown> {
  const sessionId = requireString(args, 'connection_id');
  const command = requireString(args, 'command');
  const timeoutMs = optionalNumber(args, 'timeout_ms', DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
  const shell = args.shell ?? 'auto';
  if (typeof shell !== 'string' || !(SHELLS as readonly string[]).includes(shell)) {
    throw new Error(`shell must be one of: ${SHELLS.join(', ')}`);
  }

  let result: Record<string, unknown>;
  try {
    result = await client.terminalExecute(sessionId, command, timeoutMs, shell);
  } catch (err) {
    if (!isUnknownRequest(err)) throw err;
    const legacy = await legacyExecute(client, sessionId, command, timeoutMs);
    return textResult(
      { exit_code: legacy.exit_code, timed_out: legacy.timed_out, ...(legacy.timed_out && { hint: HINTS.timed_out }) },
      legacy.stdout || NO_OUTPUT,
    );
  }
  return formatExecuteResult(result);
}

export function formatExecuteResult(result: Record<string, unknown>): unknown {
  const status = result.status as string;
  const metadata: Record<string, unknown> = {
    exit_code: result.exit_code ?? null,
    status,
    timed_out: status === 'timed_out',
    duration_ms: result.duration_ms,
  };
  if (result.truncated) {
    metadata.truncated = true;
    metadata.omitted_lines = result.omitted_lines;
  }

  const screen = Array.isArray(result.screen) ? (result.screen as string[]).join('\n').trimEnd() : '';
  const hints: string[] = [];
  if (status === 'session_closed') hints.push(HINTS.session_closed);
  else if (!result.started) hints.push(HINTS.not_started);
  else if (status === 'timed_out' || status === 'interrupted') hints.push(HINTS[status]);
  if (result.truncated) hints.push(HINTS.truncated);
  const hint = hints.filter(Boolean).join(' ');
  if (hint) metadata.hint = hint;

  const text = !result.started && screen ? screen : (result.stdout as string) || NO_OUTPUT;
  return textResult(metadata, text);
}

// ---------- terminal_read_pane ----------

export function terminalReadPaneDefinition() {
  return {
    name: 'terminal_read_pane',
    description:
      'Read what the terminal shows right now as plain text (colors removed, wrapped lines joined), including ' +
      'scrollback above the visible screen — pass a higher `lines` value to retrieve more history. Works for ' +
      'full-screen programs too (editors, pagers, top, installer dialogs); `alternate_screen: true` means one is open.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the connection/session' },
        lines: {
          type: 'number',
          description: `Number of lines from the end to read (default: ${DEFAULT_PANE_LINES}, max: ${MAX_PANE_LINES})`,
          default: DEFAULT_PANE_LINES,
        },
      },
      required: ['connection_id'],
    },
  };
}

export async function terminalReadPane(client: ConduitClient, args: Record<string, unknown>): Promise<unknown> {
  const sessionId = requireString(args, 'connection_id');
  const lines = optionalNumber(args, 'lines', DEFAULT_PANE_LINES, 1, MAX_PANE_LINES);

  let screen: Record<string, unknown>;
  try {
    screen = await client.terminalReadScreen(sessionId, lines);
  } catch (err) {
    if (!isUnknownRequest(err)) throw err;
    const content = await legacyReadPane(client, sessionId, lines);
    return textResult({ total_lines: content.split('\n').length }, content || '(empty)');
  }
  const content = (screen.content as string) ?? '';
  return textResult(
    {
      total_lines: screen.total_lines,
      returned_lines: content ? content.split('\n').length : 0,
      alternate_screen: screen.alternate_screen,
    },
    content || '(empty)',
  );
}

// ---------- terminal_send_keys ----------

export function terminalSendKeysDefinition() {
  return {
    name: 'terminal_send_keys',
    description:
      'Send keystrokes or text to a terminal session: answer prompts (passwords, y/n), drive REPLs and full-screen ' +
      'programs, or interrupt a command. Escapes: \\r = Enter, \\n = newline, \\t = Tab, \\x03 = Ctrl+C, ' +
      '\\x04 = Ctrl+D, \\e or \\x1b = Escape, \\x1b[A / \\x1b[B / \\x1b[C / \\x1b[D = arrow up/down/right/left, ' +
      '\\\\ = a literal backslash. Set wait_ms to wait for the program to respond and get its new output in the same call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the connection/session' },
        keys: {
          type: 'string',
          description: 'Keys to send (supports the escapes above, e.g. "yes\\r" or "\\x03")',
        },
        wait_ms: {
          type: 'number',
          description:
            `Wait up to this many milliseconds for output to settle and return it (default: 0 = don't wait, max: ${MAX_WAIT_MS}). ` +
            'When a full-screen program is open, the current screen is returned as well.',
          default: 0,
        },
      },
      required: ['connection_id', 'keys'],
    },
  };
}

export async function terminalSendKeys(client: ConduitClient, args: Record<string, unknown>): Promise<unknown> {
  const sessionId = requireString(args, 'connection_id');
  const keyBytes = parseKeySequences(requireString(args, 'keys'));
  const waitMs = optionalNumber(args, 'wait_ms', 0, 0, MAX_WAIT_MS);

  if (waitMs === 0) {
    await client.terminalWrite(sessionId, keyBytes);
    return { success: true, bytes_sent: keyBytes.length };
  }

  let result: Record<string, unknown>;
  try {
    result = await client.terminalSendKeys(sessionId, keyBytes, waitMs);
  } catch (err) {
    if (!isUnknownRequest(err)) throw err;
    const output = await legacySendKeys(client, sessionId, keyBytes, waitMs);
    return textResult({ success: true, bytes_sent: keyBytes.length }, output || NO_OUTPUT);
  }

  const screen = Array.isArray(result.screen) ? (result.screen as string[]).join('\n').trimEnd() : '';
  const metadata: Record<string, unknown> = { success: true, bytes_sent: result.bytes_sent };
  if (result.truncated) metadata.truncated = true;
  if (screen) {
    metadata.alternate_screen = true;
    return textResult(metadata, screen);
  }
  return textResult(metadata, (result.output as string) || NO_OUTPUT);
}

// ---------- local_shell_create ----------

export function localShellCreateDefinition() {
  return {
    name: 'local_shell_create',
    description:
      'Create a new local shell session on the machine running Conduit. Returns a session_id to use as ' +
      'connection_id with the terminal tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        shell_type: {
          type: 'string',
          description: 'Shell type: bash, zsh, powershell, cmd (default: system default)',
        },
        working_directory: {
          type: 'string',
          description: 'Initial working directory',
        },
      },
      required: [],
    },
  };
}

export async function localShellCreate(
  client: ConduitClient,
  args: { shell_type?: string; working_directory?: string },
): Promise<unknown> {
  const sessionId = await client.localShellCreate(
    args.shell_type ?? null,
    args.working_directory ?? null,
  );

  return {
    session_id: sessionId,
    shell_type: args.shell_type ?? 'default',
    working_directory: args.working_directory ?? null,
  };
}
