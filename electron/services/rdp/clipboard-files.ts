/**
 * clipboard-files.ts — Platform-specific clipboard file read/write.
 *
 * Reads file paths from the system clipboard (when user copies files in Finder/Explorer)
 * and writes downloaded file paths back to the clipboard.
 */

import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clipboard, ClipboardItem } from 'electron';

export interface ClipboardFile {
  path: string;
  name: string;
  size: number;
  isDirectory: boolean;
}

const URI_LIST = 'text/uri-list';
const CLIPBOARD_TIMEOUT_MS = 5000;
const CLIPBOARD_WAKE_INTERVAL_MS = 10;

function osClipboardFormat(name: string): string {
  return `electron application/osclipboard;format="${name}"`;
}

/**
 * Run an Electron clipboard call. On Linux, Electron 44's clipboard promises
 * can stall until something wakes the main event loop, so keep it awake while
 * the call is pending, and time out so a stuck call can't block clipboard sync.
 */
export async function clipboardCall<T>(
  op: () => Promise<T>,
  timeoutMs: number = CLIPBOARD_TIMEOUT_MS,
): Promise<T> {
  const keepAwake = setInterval(() => {}, CLIPBOARD_WAKE_INTERVAL_MS);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Clipboard call timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearInterval(keepAwake);
    clearTimeout(timeout);
  }
}

/**
 * Read file paths from the system clipboard.
 * Returns null if the clipboard doesn't contain files.
 */
export async function readClipboardFiles(): Promise<string[] | null> {
  try {
    if (process.platform === 'darwin') {
      return await readClipboardFilesMacOS();
    } else if (process.platform === 'win32') {
      return await readClipboardFilesWindows();
    } else {
      return await readClipboardFilesLinux();
    }
  } catch (e) {
    console.error('[clipboard-files] Failed to read clipboard files:', e);
    return null;
  }
}

/**
 * Write file paths to the system clipboard so the user can paste them.
 */
export async function writeClipboardFiles(filePaths: string[]): Promise<boolean> {
  if (!filePaths.length) return false;

  try {
    if (process.platform === 'darwin') {
      return await writeClipboardFilesMacOS(filePaths);
    } else if (process.platform === 'win32') {
      return writeClipboardFilesWindows(filePaths);
    } else {
      return writeClipboardFilesLinux(filePaths);
    }
  } catch (e) {
    console.error('[clipboard-files] Failed to write clipboard files:', e);
    return false;
  }
}

/**
 * Check if the clipboard currently contains files (not text).
 *
 * Electron maps native file lists (NSPasteboard file URLs on macOS,
 * CF_HDROP/FileNameW on Windows) to text/uri-list. Legacy formats Chromium
 * doesn't map only show up as raw OS formats. On Linux text/uri-list can hold
 * non-file URIs, so verify at least one file:// entry exists.
 */
export async function clipboardHasFiles(): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      return await hasAnyType(URI_LIST, osClipboardFormat('NSFilenamesPboardType'));
    } else if (process.platform === 'win32') {
      return await hasAnyType(URI_LIST, osClipboardFormat('FileName'));
    }

    const uriList = await readUriList();
    return uriList !== null && parseFileUriList(uriList) !== null;
  } catch {
    return false;
  }
}

/* ── Shared helpers ────────────────────────────────────────────────── */

async function hasAnyType(...types: string[]): Promise<boolean> {
  for (const type of types) {
    if (await clipboardCall(() => clipboard.has(type))) return true;
  }
  return false;
}

async function readUriList(): Promise<string | null> {
  if (!(await clipboardCall(() => clipboard.has(URI_LIST)))) return null;

  const items = await clipboardCall(() => clipboard.read());
  const lists = await Promise.all(
    items
      .filter(item => item.types.includes(URI_LIST))
      .map(item => clipboardCall(async () => {
        const data = await item.getType(URI_LIST);
        return 'text' in data ? data.text() : '';
      })),
  );
  const joined = lists.filter(list => list.length > 0).join('\r\n');
  return joined.length > 0 ? joined : null;
}

/**
 * Parse a text/uri-list into local file paths.
 * Skips comments and non-file URIs; decodes percent-encoding.
 */
export function parseFileUriList(
  uriList: string,
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  const paths = uriList
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('file://'))
    .flatMap(uri => {
      try {
        return [fileURLToPath(uri, { windows: platform === 'win32' })];
      } catch {
        return [];
      }
    });

  return paths.length > 0 ? paths : null;
}

/* ── macOS ─────────────────────────────────────────────────────────── */

async function readClipboardFilesMacOS(): Promise<string[] | null> {
  // NSPasteboard first: it is the proven path for Finder's lazily provided file
  // data. Electron's text/uri-list is the fallback.
  try {
    const paths = readPasteboardFileUrlsMacOS();
    if (paths) return paths;
  } catch (e) {
    console.log('[clipboard-files] macOS NSPasteboard read failed:', e);
  }

  const uriList = await readUriList();
  return uriList ? parseFileUriList(uriList) : null;
}

function readPasteboardFileUrlsMacOS(): string[] | null {
  const script = `
    use framework "AppKit"
    set pb to current application's NSPasteboard's generalPasteboard()
    set urls to pb's readObjectsForClasses:{current application's NSURL} options:(missing value)
    if urls is missing value then return ""
    set output to ""
    repeat with u in urls
      if output is not "" then set output to output & (character id 10)
      set output to output & (u's |path|() as text)
    end repeat
    return output
  `;

  const result = execSync(`osascript -l AppleScript -e '${script.replace(/'/g, "'\\''")}'`, {
    timeout: 5000,
    encoding: 'utf-8',
  }).trim();

  if (!result) return null;

  const paths = result.split('\n').map(p => p.trim()).filter(p => p.length > 0);
  return paths.length > 0 ? paths : null;
}

async function writeClipboardFilesMacOS(filePaths: string[]): Promise<boolean> {
  // Electron writes one file-URL pasteboard item per path. The old osascript
  // writeObjects approach intermittently dropped items (seen on macOS 27).
  console.log('[clipboard-files] macOS write: using Electron clipboard for', filePaths);
  const uriList = filePaths.map(p => pathToFileURL(p).href).join('\r\n');
  await clipboardCall(() => clipboard.write([new ClipboardItem({ [URI_LIST]: uriList })]));
  return true;
}

/* ── Windows ───────────────────────────────────────────────────────── */

async function readClipboardFilesWindows(): Promise<string[] | null> {
  // Try PowerShell CF_HDROP first (native file drop list)
  try {
    const result = execSync(
      'powershell -NoProfile -Command "(Get-Clipboard -Format FileDropList).FullName"',
      { timeout: 5000, encoding: 'utf-8' }
    ).trim();

    console.log('[clipboard-files] Windows PowerShell FileDropList result:', JSON.stringify(result));
    if (result) {
      const paths = result.split('\n').map(p => p.trim()).filter(p => p.length > 0);
      if (paths.length > 0) return paths;
    }
  } catch (e) {
    console.log('[clipboard-files] Windows PowerShell FileDropList failed:', e);
  }

  // Fallback: Electron exposes CF_HDROP / FileNameW as text/uri-list
  const uriList = await readUriList();
  console.log('[clipboard-files] Windows text/uri-list:', JSON.stringify(uriList));
  const paths = uriList ? parseFileUriList(uriList, 'win32') : null;
  if (paths) {
    console.log('[clipboard-files] Windows parsed URI paths:', paths);
    return paths;
  }

  console.log('[clipboard-files] Windows: no files found in clipboard');
  return null;
}

function writeClipboardFilesWindows(filePaths: string[]): boolean {
  const pathsArg = filePaths.map(p => `'${p.replace(/'/g, "''")}'`).join(',');
  execSync(
    `powershell -NoProfile -Command "Set-Clipboard -Path @(${pathsArg})"`,
    { timeout: 5000 }
  );
  return true;
}

/* ── Linux ─────────────────────────────────────────────────────────── */

async function readClipboardFilesLinux(): Promise<string[] | null> {
  const uriList = await readUriList();
  return uriList ? parseFileUriList(uriList) : null;
}

function writeClipboardFilesLinux(filePaths: string[]): boolean {
  const uriList = filePaths.map(p => `file://${encodeURI(p)}`).join('\r\n') + '\r\n';

  // Try xclip first, fall back to xsel. stdio 'ignore': xclip forks a process
  // to own the clipboard, and an inherited pipe keeps execSync waiting until timeout.
  try {
    execSync(`printf '%s' '${uriList.replace(/'/g, "'\\''")}' | xclip -selection clipboard -t text/uri-list`, {
      timeout: 5000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    try {
      execSync(`printf '%s' '${uriList.replace(/'/g, "'\\''")}' | xsel --clipboard --input`, {
        timeout: 5000,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }
}
