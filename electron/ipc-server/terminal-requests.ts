/**
 * Validation for the agent-facing terminal IPC requests (TerminalExecute,
 * TerminalSendKeys, TerminalReadScreen). Payloads come from the MCP process,
 * so every field is checked before it reaches the TerminalManager.
 */

import { TerminalError } from '../services/terminal/errors.js';
import type { ExecuteRequest } from '../services/terminal/manager.js';
import type { ShellPreference } from '../services/terminal/shell-wrapper.js';

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const MIN_EXEC_TIMEOUT_MS = 1_000;
const MAX_EXEC_TIMEOUT_MS = 600_000;
const MAX_COMMAND_CHARS = 256_000;
const MAX_KEY_BYTES = 64_000;
const MAX_WAIT_MS = 120_000;
const MIN_IDLE_MS = 50;
const MAX_IDLE_MS = 10_000;
const DEFAULT_SCREEN_LINES = 50;
const MAX_SCREEN_LINES = 5_000;

const SHELL_ALIASES: Record<string, ShellPreference> = {
  auto: 'auto',
  posix: 'posix',
  bash: 'posix',
  zsh: 'posix',
  sh: 'posix',
  powershell: 'powershell',
  pwsh: 'powershell',
};

function invalid(message: string): TerminalError {
  return new TerminalError('INVALID_ARGUMENT', message);
}

function requireSessionId(payload: Record<string, unknown>): string {
  const id = payload.session_id;
  if (typeof id !== 'string' || id.trim() === '') throw invalid('session_id must be a non-empty string');
  return id;
}

function optionalNumber(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${name} must be a number`);
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function parseExecuteRequest(payload: Record<string, unknown> = {}): { sessionId: string; request: ExecuteRequest } {
  const sessionId = requireSessionId(payload);
  const { command } = payload;
  if (typeof command !== 'string' || command.trim() === '') throw invalid('command must be a non-empty string');
  if (command.length > MAX_COMMAND_CHARS) {
    throw invalid(
      `command is ${command.length} characters; the limit is ${MAX_COMMAND_CHARS}. ` +
        'Split large file writes into several commands (e.g. append with >> in chunks).',
    );
  }
  const shellName = payload.shell ?? 'auto';
  const shell = typeof shellName === 'string' ? SHELL_ALIASES[shellName.toLowerCase()] : undefined;
  if (!shell) throw invalid('shell must be one of: auto, posix, powershell');

  const timeoutMs = optionalNumber(
    payload.timeout_ms, 'timeout_ms', DEFAULT_EXEC_TIMEOUT_MS, MIN_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS,
  );
  return { sessionId, request: { command, timeoutMs, shell } };
}

export function parseSendKeysRequest(payload: Record<string, unknown> = {}): {
  sessionId: string;
  data: Uint8Array;
  waitMs: number;
  idleMs: number | undefined;
} {
  const sessionId = requireSessionId(payload);
  const { data } = payload;
  if (!Array.isArray(data) || data.length === 0) throw invalid('data must be a non-empty array of bytes');
  if (data.length > MAX_KEY_BYTES) throw invalid(`data exceeds ${MAX_KEY_BYTES} bytes`);
  if (!data.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw invalid('data must contain bytes (0-255)');

  const waitMs = optionalNumber(payload.wait_ms, 'wait_ms', 0, 0, MAX_WAIT_MS);
  const idleMs = payload.idle_ms === undefined || payload.idle_ms === null
    ? undefined
    : optionalNumber(payload.idle_ms, 'idle_ms', MIN_IDLE_MS, MIN_IDLE_MS, MAX_IDLE_MS);
  return { sessionId, data: Uint8Array.from(data as number[]), waitMs, idleMs };
}

export function parseReadScreenRequest(payload: Record<string, unknown> = {}): { sessionId: string; lines: number } {
  const sessionId = requireSessionId(payload);
  const lines = optionalNumber(payload.lines, 'lines', DEFAULT_SCREEN_LINES, 1, MAX_SCREEN_LINES);
  return { sessionId, lines };
}
