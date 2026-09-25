/**
 * Builds the single line that terminal_execute types into a shell.
 *
 * The command travels encoded rather than as raw multi-line input, so the
 * shell parses all of it before running any of it: heredocs, comments, tabs,
 * `!`, and trailing `&`/`;` behave as they would in a script, and nothing the
 * line editor sees can be mistaken for a key binding or history expansion.
 * Start/end markers are assembled at runtime so the echoed input never
 * contains them literally.
 *
 * Without bracketed paste, a long command is typed as several short lines
 * that each wait for an acknowledgement: dash/sh (no line editor) cap a line at
 * the tty's canonical limit (1024 bytes on macOS) and busybox's editor at 1024
 * chars, while typing many lines ahead into zsh or old bash loses input.
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { TerminalError } from './errors.js';

export type ShellFamily = 'posix' | 'powershell';
export type ShellKind = ShellFamily | 'cmd' | 'fish' | 'unknown';
export type ShellPreference = 'auto' | ShellFamily;

export const MARKER_PREFIX = '__CONDUIT_';

const NON_POSIX_SHELLS = new Set(['nu', 'xonsh', 'elvish', 'csh', 'tcsh']);

// Longest line typed in one go without bracketed paste (under the 1024 limits above).
const POSIX_SINGLE_LINE_MAX = 900;
const POSIX_CHUNK_CHARS = 700;

export function newMarkerId(): string {
  return randomBytes(6).toString('hex');
}

export function startMarker(id: string): string {
  return `${MARKER_PREFIX}START_${id}__`;
}

export function endMarkerPrefix(id: string): string {
  return `${MARKER_PREFIX}END_${id}_EXIT_`;
}

export function endMarkerPattern(id: string): RegExp {
  return new RegExp(`${MARKER_PREFIX}END_${id}_EXIT_(\\d+)__`);
}

export function ackMarker(id: string, index: number): string {
  return `${MARKER_PREFIX}ACK_${id}_${index}__`;
}

export function detectShellKind(shellPath: string): ShellKind {
  const name = path.posix.basename(shellPath.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  if (name === 'pwsh' || name === 'powershell') return 'powershell';
  if (name === 'cmd') return 'cmd';
  if (name === 'fish') return 'fish';
  if (NON_POSIX_SHELLS.has(name)) return 'unknown';
  return 'posix';
}

const UNSUPPORTED_SHELL_HINT =
  'terminal_execute supports POSIX shells (bash, zsh, sh, dash, ash, ksh) and PowerShell. ' +
  'Use terminal_send_keys with wait_ms to drive this session instead';

export function resolveShellFamily(preference: ShellPreference, kind: ShellKind): ShellFamily {
  if (preference !== 'auto') return preference;
  if (kind === 'posix' || kind === 'powershell') return kind;
  const what = kind === 'cmd' ? 'cmd.exe' : kind === 'fish' ? 'fish' : 'a program that is not a known shell';
  throw new TerminalError('UNSUPPORTED_SHELL', `This session runs ${what}. ${UNSUPPORTED_SHELL_HINT}.`);
}

export function normalizeCommand(command: string): string {
  return command.replace(/\r\n?/g, '\n').replace(/\0/g, '');
}

function escapeByte(byte: number): string {
  if (byte === 0x5c) return '\\\\';
  if (byte === 0x27) return "'\\''";
  if (byte === 0x21) return '\\0041';
  if (byte === 0x0a) return '\\n';
  if (byte === 0x09) return '\\t';
  if (byte >= 0x20 && byte < 0x7f) return String.fromCharCode(byte);
  return `\\0${byte.toString(8).padStart(3, '0')}`;
}

/**
 * Escapes text as a single-quoted `printf '%b'` argument that is pure
 * printable ASCII: non-ASCII bytes become octal so a line editor in a
 * non-UTF-8 locale can't treat them as Meta keys. One token per input byte.
 */
export function escapeTokensForPrintfB(text: string): string[] {
  return Array.from(Buffer.from(text, 'utf8'), escapeByte);
}

export function escapeForPrintfB(text: string): string {
  return escapeTokensForPrintfB(text).join('');
}

// `command eval` stops dash/ash from abandoning the rest of the line on a
// syntax error; zsh's `command` means "external binary", so it gets plain eval.
function posixRunSuffix(id: string): string {
  return (
    `printf '${MARKER_PREFIX}%s_${id}__\\n' START; ` +
    `case \${ZSH_VERSION-} in '') command eval "$__conduit_cmd";; *) eval "$__conduit_cmd";; esac; ` +
    `printf '\\n${MARKER_PREFIX}%s_${id}_EXIT_%d__\\n' END "$?"; unset __conduit_cmd`
  );
}

export function buildPosixLine(command: string, id: string): string {
  const payload = escapeForPrintfB(normalizeCommand(command));
  return ` __conduit_cmd=$(printf '%b' '${payload}'); ${posixRunSuffix(id)}`;
}

/** Splits the escaped command into short lines that build `$__conduit_cmd` piece by piece. */
export function buildPosixChunkedLines(command: string, id: string): { preludes: Prelude[]; final: string } {
  const chunks: string[] = [];
  let current = '';
  for (const token of escapeTokensForPrintfB(normalizeCommand(command))) {
    if (current.length + token.length > POSIX_CHUNK_CHARS) {
      chunks.push(current);
      current = '';
    }
    current += token;
  }
  chunks.push(current);

  const preludes = chunks.map((chunk, i) => ({
    line:
      ` __conduit_cmd=${i === 0 ? '' : '"$__conduit_cmd"'}'${chunk}'; ` +
      `printf '${MARKER_PREFIX}%s_${id}_${i}__\\n' ACK`,
    ack: ackMarker(id, i),
  }));
  return { preludes, final: ` __conduit_cmd=$(printf '%b' "$__conduit_cmd"); ${posixRunSuffix(id)}` };
}

// Output is piped through Out-Host so PowerShell's deferred table formatting
// can't print after the end marker; the appended `$?` capture records the
// status of the command's last statement.
export function buildPowerShellLine(command: string, id: string): string {
  const b64 = Buffer.from(normalizeCommand(command), 'utf8').toString('base64');
  return (
    ` $__conduit_cmd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));` +
    `Write-Host ('${MARKER_PREFIX}'+'START_${id}__');$global:LASTEXITCODE=0;$__conduit_ok=$true;` +
    `try{[void][ScriptBlock]::Create($__conduit_cmd);` +
    `. ([ScriptBlock]::Create($__conduit_cmd+"\`n\`$__conduit_ok=\`$?"))|Out-Host;` +
    `$__conduit_rc=if($__conduit_ok){0}elseif($LASTEXITCODE){$LASTEXITCODE}else{1}}` +
    `catch{$__conduit_e=$_.Exception;if($__conduit_e.InnerException){$__conduit_e=$__conduit_e.InnerException};` +
    `Write-Host $__conduit_e.Message;$__conduit_rc=1};` +
    `Write-Host ("\`n${MARKER_PREFIX}"+'END_${id}_EXIT_'+$__conduit_rc+'__');` +
    `Remove-Variable __conduit_cmd,__conduit_ok,__conduit_rc,__conduit_e -ErrorAction SilentlyContinue`
  );
}

export interface Prelude {
  /** Line to type (without Enter). */
  line: string;
  /** Output that confirms the shell has consumed the line. */
  ack: string;
}

export interface CommandInput {
  /** Lines typed one at a time, each after the previous one's ack, before `final`. */
  preludes: Prelude[];
  /** Line that runs the command and prints the markers. */
  final: string;
}

/** Decides how the command is typed: one line (as a paste when supported) or acknowledged pieces. */
export function planCommandInput(
  family: ShellFamily,
  command: string,
  id: string,
  bracketedPaste: boolean,
): CommandInput {
  if (family === 'powershell') return { preludes: [], final: buildPowerShellLine(command, id) };
  if (bracketedPaste) return { preludes: [], final: `\x1b[200~${buildPosixLine(command, id)}\x1b[201~` };
  const line = buildPosixLine(command, id);
  if (line.length <= POSIX_SINGLE_LINE_MAX) return { preludes: [], final: line };
  return buildPosixChunkedLines(command, id);
}
