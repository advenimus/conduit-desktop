/**
 * Win32 FFI bindings for CreateProcessWithLogonW via koffi.
 *
 * Used by executor.ts on Windows to run commands as a different user
 * without requiring admin privileges or WinRM/PSRemoting.
 *
 * Only imported on Windows via dynamic import() — zero impact on macOS/Linux.
 */

import koffi from 'koffi';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------- Constants ----------

const LOGON_WITH_PROFILE = 0x00000001;
const CREATE_NO_WINDOW = 0x08000000;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const INFINITE = 0xFFFFFFFF;
const WAIT_OBJECT_0 = 0x00000000;
const WAIT_TIMEOUT = 0x00000102;

// ---------- Struct definitions ----------

const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'void *',
  lpDesktop: 'void *',
  lpTitle: 'void *',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: 'void *',
  hStdInput: 'void *',
  hStdOutput: 'void *',
  hStdError: 'void *',
});

const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: 'void *',
  hThread: 'void *',
  dwProcessId: 'uint32',
  dwThreadId: 'uint32',
});

// ---------- DLL bindings ----------

const advapi32 = koffi.load('advapi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const CreateProcessWithLogonW = advapi32.func(
  'int __stdcall CreateProcessWithLogonW(' +
    'str16 lpUsername, str16 lpDomain, str16 lpPassword, ' +
    'uint32 dwLogonFlags, str16 lpApplicationName, str16 lpCommandLine, ' +
    'uint32 dwCreationFlags, void *lpEnvironment, str16 lpCurrentDirectory, ' +
    '_In_ STARTUPINFOW *lpStartupInfo, _Out_ PROCESS_INFORMATION *lpProcessInformation' +
  ')'
);

const WaitForSingleObject = kernel32.func(
  'uint32 __stdcall WaitForSingleObject(void *hHandle, uint32 dwMilliseconds)'
);

const GetExitCodeProcess = kernel32.func(
  'int __stdcall GetExitCodeProcess(void *hProcess, _Out_ uint32 *lpExitCode)'
);

const CloseHandle = kernel32.func(
  'int __stdcall CloseHandle(void *hObject)'
);

const GetLastError = kernel32.func(
  'uint32 __stdcall GetLastError()'
);

const TerminateProcess = kernel32.func(
  'int __stdcall TerminateProcess(void *hProcess, uint32 uExitCode)'
);

// ---------- Executable resolution ----------

/**
 * Well-known install paths for common executables that may not be on
 * the Electron process's PATH (since lpEnvironment=null inherits our env).
 */
const KNOWN_PATHS: Record<string, string[]> = {
  'pwsh':       ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
  'pwsh.exe':   ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
  'powershell': ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
  'powershell.exe': ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
  'python':     ['C:\\Python312\\python.exe', 'C:\\Python311\\python.exe', 'C:\\Python310\\python.exe'],
  'python.exe': ['C:\\Python312\\python.exe', 'C:\\Python311\\python.exe', 'C:\\Python310\\python.exe'],
};

/**
 * Resolve a bare executable name to its full path.
 * Tries `where.exe` first, then falls back to known install locations.
 * Returns the original name if resolution fails (let the OS try anyway).
 */
function resolveExecutable(name: string): string {
  // Already a full path or contains path separators
  if (name.includes('\\') || name.includes('/') || name.includes(':')) return name;

  // Try where.exe (searches the current process's PATH)
  try {
    const result = execSync(`where.exe "${name}" 2>nul`, { encoding: 'utf-8', timeout: 5000 });
    const firstLine = result.trim().split(/\r?\n/)[0];
    if (firstLine && fs.existsSync(firstLine)) return firstLine;
  } catch { /* not found via where */ }

  // Try known install paths
  const candidates = KNOWN_PATHS[name.toLowerCase()];
  if (candidates) {
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }

  // Scan for PowerShell versioned directories (7, 7-preview, etc.)
  const lower = name.toLowerCase().replace(/\.exe$/, '');
  if (lower === 'pwsh') {
    const psBase = 'C:\\Program Files\\PowerShell';
    try {
      if (fs.existsSync(psBase)) {
        const dirs = fs.readdirSync(psBase).sort().reverse(); // highest version first
        for (const dir of dirs) {
          const candidate = path.join(psBase, dir, 'pwsh.exe');
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch { /* ignore scan errors */ }
  }

  return name;
}

/**
 * Quote a path if it contains spaces and isn't already quoted.
 */
function quotePath(p: string): string {
  if (p.includes(' ') && !p.startsWith('"')) return `"${p}"`;
  return p;
}

/**
 * Resolve the executable in a command line string.
 * Handles both quoted ("C:\path\exe" args) and unquoted (exe args) forms.
 * Always quotes resolved paths that contain spaces.
 */
function resolveCommandLine(commandLine: string): string {
  const trimmed = commandLine.trim();

  // Quoted executable: "path to exe" args...
  if (trimmed.startsWith('"')) {
    const endQuote = trimmed.indexOf('"', 1);
    if (endQuote > 1) {
      const exe = trimmed.substring(1, endQuote);
      const rest = trimmed.substring(endQuote + 1);
      const resolved = resolveExecutable(exe);
      return `"${resolved}"${rest}`;
    }
  }

  // Unquoted: split on first space
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    return quotePath(resolveExecutable(trimmed));
  }

  const exe = trimmed.substring(0, spaceIdx);
  const rest = trimmed.substring(spaceIdx);
  return `${quotePath(resolveExecutable(exe))}${rest}`;
}

// ---------- Public API ----------

/** Opaque Win32 HANDLE — returned by koffi as an unknown value */
type HANDLE = unknown;

export interface CreateProcessOptions {
  username: string;
  domain: string;       // '.' for local
  password: string;
  commandLine: string;
  cwd?: string;
  guiApp?: boolean;
  timeoutMs?: number;
  /** Called with the process handle immediately after creation, before waiting.
   *  Use this to store the handle for cancel support. */
  onProcessCreated?: (handle: HANDLE) => void;
}

export interface CreateProcessResult {
  exitCode: number;
  output: string;
}

/**
 * Terminate a Win32 process by handle.
 * Only sends TerminateProcess — does NOT close the handle (the finally block
 * in createProcessAsUser owns handle cleanup to prevent double-close).
 */
export function terminateProcess(handle: HANDLE): void {
  if (!handle) return;
  try {
    TerminateProcess(handle, 1);
  } catch {
    // Best effort — process may already be gone
  }
}

/**
 * Create a process as a different user via CreateProcessWithLogonW.
 *
 * CLI commands: wraps in cmd.exe with output redirected to a temp file.
 * GUI apps: launches directly, returns immediately.
 */
export async function createProcessAsUser(options: CreateProcessOptions): Promise<CreateProcessResult> {
  const {
    username,
    domain,
    password,
    commandLine,
    cwd,
    guiApp = false,
    timeoutMs = 0,
    onProcessCreated,
  } = options;

  const si: Record<string, unknown> = {
    cb: koffi.sizeof(STARTUPINFOW),
    lpReserved: null,
    lpDesktop: null,
    lpTitle: null,
    dwX: 0,
    dwY: 0,
    dwXSize: 0,
    dwYSize: 0,
    dwXCountChars: 0,
    dwYCountChars: 0,
    dwFillAttribute: 0,
    dwFlags: 0,
    wShowWindow: 0,
    cbReserved2: 0,
    lpReserved2: null,
    hStdInput: null,
    hStdOutput: null,
    hStdError: null,
  };

  const pi: Record<string, unknown> = {
    hProcess: null,
    hThread: null,
    dwProcessId: 0,
    dwThreadId: 0,
  };

  // Resolve bare executable names to full paths (the spawned process inherits
  // the Electron app's PATH which may not include common tools like pwsh, python, etc.)
  const resolvedCmdLine = resolveCommandLine(commandLine);

  // For GUI apps, launch directly without cmd.exe wrapper
  if (guiApp) {
    const creationFlags = CREATE_UNICODE_ENVIRONMENT;

    const ok = CreateProcessWithLogonW(
      username,
      domain,
      password,
      LOGON_WITH_PROFILE,
      null,                 // lpApplicationName
      resolvedCmdLine,      // lpCommandLine (resolved)
      creationFlags,
      null,                 // lpEnvironment (inherit)
      cwd || null,
      si,
      pi,
    );

    if (!ok) {
      const err = GetLastError();
      throw new Error(`CreateProcessWithLogonW failed (error ${err}): ${resolvedCmdLine}`);
    }

    // Clean up handles — don't wait for GUI apps
    if (pi.hProcess) CloseHandle(pi.hProcess as HANDLE);
    if (pi.hThread) CloseHandle(pi.hThread as HANDLE);

    return { exitCode: 0, output: `Launched: ${resolvedCmdLine}\n` };
  }

  // CLI: wrap command with output redirect to temp file.
  // Use the calling user's temp dir (readable by us) and grant the target user
  // write access via icacls so the cross-user cmd.exe process can write to it.
  const tmpDir = os.tmpdir();
  const fileId = crypto.randomBytes(8).toString('hex');
  const outFile = path.join(tmpDir, `conduit-${fileId}-out.txt`);

  // Pre-create the file (owned by us, readable by us) then grant target user write access
  fs.writeFileSync(outFile, '', { mode: 0o666 });
  try {
    const targetUser = domain === '.' ? username : `${domain}\\${username}`;
    execSync(`icacls "${outFile}" /grant "${targetUser}:(M)" /Q`, { stdio: 'ignore' });
  } catch {
    // If icacls fails (e.g. user doesn't exist yet), continue anyway —
    // the command may still succeed if running in an admin context
  }

  // cmd.exe /S /C ""command" > "outfile" 2>&1"
  const wrappedCmd = `cmd.exe /S /C "${resolvedCmdLine} > "${outFile}" 2>&1"`;

  const creationFlags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;

  const ok = CreateProcessWithLogonW(
    username,
    domain,
    password,
    LOGON_WITH_PROFILE,
    null,
    wrappedCmd,
    creationFlags,
    null,
    cwd || null,
    si,
    pi,
  );

  if (!ok) {
    const err = GetLastError();
    // Clean up temp file on failure
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
    throw new Error(`CreateProcessWithLogonW failed (error ${err}): ${wrappedCmd}`);
  }

  const hProcess = pi.hProcess as HANDLE;
  const hThread = pi.hThread as HANDLE;

  // Notify caller of the handle before waiting — enables cancel support
  if (onProcessCreated) onProcessCreated(hProcess);

  try {
    // Wait for process to exit (async to avoid blocking Node event loop)
    const waitMs = timeoutMs > 0 ? timeoutMs : INFINITE;

    const waitResult: number = await new Promise((resolve, reject) => {
      WaitForSingleObject.async(hProcess, waitMs, (err: Error | null, result: number) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    if (waitResult === WAIT_TIMEOUT) {
      TerminateProcess(hProcess, 1);
      throw new Error(`Process timed out after ${timeoutMs}ms`);
    }

    if (waitResult !== WAIT_OBJECT_0) {
      throw new Error(`WaitForSingleObject returned unexpected value: ${waitResult}`);
    }

    // Get exit code
    const exitCodeBuf = [0];
    GetExitCodeProcess(hProcess, exitCodeBuf);
    const exitCode = exitCodeBuf[0];

    // Read output file
    let output = '';
    try {
      if (fs.existsSync(outFile)) {
        output = fs.readFileSync(outFile, 'utf-8');
      }
    } catch {
      // Output file may not exist if command was killed
    }

    return { exitCode, output };
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }

    // Close handles
    try { CloseHandle(hProcess); } catch { /* ignore */ }
    try { CloseHandle(hThread); } catch { /* ignore */ }
  }
}
