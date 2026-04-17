/**
 * Terminal MCP tools.
 *
 * Port of crates/conduit-mcp/src/tools/terminal.rs + server.rs terminal methods.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ConduitClient } from '../ipc-client.js';

// ---------- parse_key_sequences ----------

/**
 * Parse key escape sequences like \x03 for Ctrl+C.
 * Port of crates/conduit-mcp/src/tools/mod.rs::parse_key_sequences
 */
export function parseKeySequences(input: string): Buffer {
  const result: number[] = [];
  let i = 0;

  while (i < input.length) {
    if (input[i] === '\\' && i + 1 < input.length) {
      const next = input[i + 1];
      if (next === 'x' && i + 3 < input.length) {
        const hex = input.slice(i + 2, i + 4);
        const byte = parseInt(hex, 16);
        if (!isNaN(byte)) {
          result.push(byte);
          i += 4;
          continue;
        }
      }
      switch (next) {
        case 'n':
          result.push(0x0a);
          i += 2;
          continue;
        case 'r':
          result.push(0x0d);
          i += 2;
          continue;
        case 't':
          result.push(0x09);
          i += 2;
          continue;
        case '\\':
          result.push(0x5c);
          i += 2;
          continue;
        default:
          result.push(0x5c);
          i += 1;
          continue;
      }
    }
    // Regular character - encode as UTF-8
    const buf = Buffer.from(input[i], 'utf-8');
    for (const b of buf) {
      result.push(b);
    }
    i += 1;
  }

  return Buffer.from(result);
}

// ---------- Tool definitions ----------

export function terminalExecuteDefinition() {
  return {
    name: 'terminal_execute',
    description: 'Execute a command in a terminal session and wait for completion',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the connection/session' },
        command: { type: 'string', description: 'Command to execute' },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
          default: 30000,
        },
      },
      required: ['connection_id', 'command'],
    },
  };
}

/** Strip ANSI SGR escape sequences from a string for marker searching. */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Find a marker at the start of a line in the buffer.
 * This skips markers embedded in the echoed command (which appear mid-line)
 * and only matches the actual echo output (which appears on its own line).
 */
function findAtLineStart(buffer: string, marker: string): number {
  if (buffer.startsWith(marker)) return 0;
  const idx = buffer.indexOf('\n' + marker);
  return idx === -1 ? -1 : idx + 1;
}

export async function terminalExecute(
  client: ConduitClient,
  args: { connection_id: string; command: string; timeout_ms?: number },
): Promise<unknown> {
  const timeoutMs = args.timeout_ms ?? 30000;

  // Wait for shell to be ready (buffer should have content from the prompt)
  const readyDeadline = Date.now() + Math.min(timeoutMs, 5000);
  while (Date.now() < readyDeadline) {
    const buf = await client.terminalReadBuffer(args.connection_id, 10);
    if (buf.trim().length > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Generate unique marker for this execution
  const markerId = uuidv4().replace(/-/g, '').slice(0, 8);
  const startMarker = `__CONDUIT_START_${markerId}__`;
  const endMarker = `__CONDUIT_END_${markerId}_EXIT_`;

  // Wrapped command: echo markers are filtered from the display by the main
  // process (TerminalManager.emitToRenderer) but remain in the backend buffer
  // so this tool can detect command completion and extract output.
  const wrappedCommand = `echo '${startMarker}'; ${args.command}; echo '${endMarker}'"$?"'__'\n`;

  await client.terminalWrite(args.connection_id, Buffer.from(wrappedCommand));

  // Poll for completion
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 100;
  let timedOut = false;
  let exitCode = 0;
  let stdout = '';

  while (true) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }

    const buffer = await client.terminalReadBuffer(args.connection_id, 500);
    const cleanBuffer = stripAnsi(buffer);

    // Look for end marker at start of a line (skip echoed command which has it mid-line)
    const endPos = findAtLineStart(cleanBuffer, endMarker);
    if (endPos !== -1) {
      const afterMarker = cleanBuffer.slice(endPos + endMarker.length);
      const codeEnd = afterMarker.indexOf('__');
      if (codeEnd !== -1) {
        const codeStr = afterMarker.slice(0, codeEnd);
        exitCode = parseInt(codeStr, 10) || 0;
      }

      // Extract output between markers (also at line boundaries)
      const startPos = findAtLineStart(cleanBuffer, startMarker);
      if (startPos !== -1) {
        let contentStart = startPos + startMarker.length;
        const nlIdx = cleanBuffer.indexOf('\n', contentStart);
        if (nlIdx !== -1 && nlIdx < endPos) {
          contentStart = nlIdx + 1;
        }
        if (contentStart < endPos) {
          stdout = cleanBuffer.slice(contentStart, endPos).trimEnd();
        }
      }
      break;
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  // If timed out, try to read partial output
  if (timedOut) {
    const buffer = await client.terminalReadBuffer(args.connection_id, 500).catch(() => '');
    const cleanBuffer = stripAnsi(buffer);
    const startPos = findAtLineStart(cleanBuffer, startMarker);
    if (startPos !== -1) {
      let contentStart = startPos + startMarker.length;
      const nlIdx = cleanBuffer.indexOf('\n', contentStart);
      if (nlIdx !== -1) {
        contentStart = nlIdx + 1;
      }
      stdout = cleanBuffer.slice(contentStart).trimEnd();
    } else {
      stdout = cleanBuffer;
    }
  }

  return {
    stdout,
    stderr: '', // PTY combines stdout/stderr
    exit_code: exitCode,
    timed_out: timedOut,
  };
}

export function terminalReadPaneDefinition() {
  return {
    name: 'terminal_read_pane',
    description: 'Read the current terminal buffer content',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the connection/session' },
        lines: {
          type: 'number',
          description: 'Number of lines to read (default: 50)',
          default: 50,
        },
        include_scrollback: {
          type: 'boolean',
          description: 'Include scrollback buffer (default: false)',
          default: false,
        },
      },
      required: ['connection_id'],
    },
  };
}

export async function terminalReadPane(
  client: ConduitClient,
  args: { connection_id: string; lines?: number },
): Promise<unknown> {
  const lines = args.lines ?? 50;
  const content = await client.terminalReadBuffer(args.connection_id, lines);
  const totalLines = content.split('\n').length;

  return {
    content,
    total_lines: totalLines,
  };
}

export function terminalSendKeysDefinition() {
  return {
    name: 'terminal_send_keys',
    description:
      'Send keyboard input to a terminal session, including control characters like \\x03 for Ctrl+C',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the connection/session' },
        keys: {
          type: 'string',
          description: 'Keys to send (supports \\x03 for Ctrl+C, etc.)',
        },
      },
      required: ['connection_id', 'keys'],
    },
  };
}

export async function terminalSendKeys(
  client: ConduitClient,
  args: { connection_id: string; keys: string },
): Promise<unknown> {
  const keyBytes = parseKeySequences(args.keys);
  await client.terminalWrite(args.connection_id, keyBytes);

  return {
    success: true,
    bytes_sent: keyBytes.length,
  };
}

export function localShellCreateDefinition() {
  return {
    name: 'local_shell_create',
    description: 'Create a new local shell session on the machine running Conduit',
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
  const sessionId = await client.localShellCreate(args.shell_type ?? null);

  return {
    session_id: sessionId,
    shell_type: args.shell_type ?? 'default',
    working_directory: args.working_directory ?? null,
  };
}
