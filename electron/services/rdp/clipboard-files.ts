/**
 * clipboard-files.ts — Platform-specific clipboard file read/write.
 *
 * Reads file paths from the system clipboard (when user copies files in Finder/Explorer)
 * and writes downloaded file paths back to the clipboard.
 */

import { execSync } from 'node:child_process';
import { clipboard } from 'electron';

export interface ClipboardFile {
  path: string;
  name: string;
  size: number;
  isDirectory: boolean;
}

/**
 * Read file paths from the system clipboard.
 * Returns null if the clipboard doesn't contain files.
 */
export function readClipboardFiles(): string[] | null {
  try {
    if (process.platform === 'darwin') {
      return readClipboardFilesMacOS();
    } else if (process.platform === 'win32') {
      return readClipboardFilesWindows();
    } else {
      return readClipboardFilesLinux();
    }
  } catch (e) {
    console.error('[clipboard-files] Failed to read clipboard files:', e);
    return null;
  }
}

/**
 * Write file paths to the system clipboard so the user can paste them.
 */
export function writeClipboardFiles(filePaths: string[]): boolean {
  if (!filePaths.length) return false;

  try {
    if (process.platform === 'darwin') {
      return writeClipboardFilesMacOS(filePaths);
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
 * macOS: Finder uses lazy clipboard (promises). Electron reports
 *   text/uri-list in availableFormats() but the buffer is empty.
 *   We detect by format presence; readClipboardFiles() verifies via osascript.
 * Linux: text/uri-list with file:// URIs in the buffer.
 * Windows: CF_HDROP which Electron reports natively.
 */
export function clipboardHasFiles(): boolean {
  try {
    const formats = clipboard.availableFormats();

    if (process.platform === 'darwin') {
      // macOS: text/uri-list presence indicates files (buffer is empty due to lazy clipboard).
      // Also check native format names in case Electron surfaces them.
      return formats.includes('text/uri-list') ||
        formats.some(f => f === 'NSFilenamesPboardType' || f === 'public.file-url');
    } else if (process.platform === 'win32') {
      // Check native Windows clipboard formats
      if (formats.some(f => f === 'CF_HDROP' || f === 'FileNameW' || f === 'FileName')) {
        return true;
      }
      // Electron on Windows reports text/uri-list with an empty buffer when files
      // are copied (lazy clipboard, same as macOS). Treat format presence as
      // indicator — readClipboardFilesWindows() will verify via PowerShell.
      if (formats.includes('text/uri-list')) {
        return true;
      }
      return false;
    } else {
      // Linux: buffer is actually populated, verify file:// URIs exist
      if (formats.includes('text/uri-list')) {
        const uriList = clipboard.readBuffer('text/uri-list').toString('utf-8');
        return uriList.split('\n').some(uri => uri.trim().startsWith('file://'));
      }
    }

    return false;
  } catch {
    return false;
  }
}

/* ── Shared helpers ────────────────────────────────────────────────── */

/**
 * Parse a text/uri-list buffer into local file paths.
 * Filters for file:// URIs and decodes percent-encoding.
 */
function parseFileUriList(uriList: string): string[] | null {
  const paths = uriList
    .split('\n')
    .map(uri => uri.trim().replace(/\r$/, ''))
    .filter(uri => uri.startsWith('file://'))
    .map(uri => decodeURIComponent(new URL(uri).pathname));

  return paths.length > 0 ? paths : null;
}

/* ── macOS ─────────────────────────────────────────────────────────── */

function readClipboardFilesMacOS(): string[] | null {
  // Try text/uri-list buffer (works on Linux, usually empty on macOS due to lazy clipboard)
  const formats = clipboard.availableFormats();
  if (formats.includes('text/uri-list')) {
    const buf = clipboard.readBuffer('text/uri-list').toString('utf-8');
    if (buf.length > 0) {
      const paths = parseFileUriList(buf);
      if (paths && paths.length > 0) return paths;
    }
  }

  // Use osascript to read file URLs from NSPasteboard (handles lazy clipboard)
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

function writeClipboardFilesMacOS(filePaths: string[]): boolean {
  // Use NSPasteboard API directly via osascript — more reliable than `set the clipboard to`
  const urlLines = filePaths
    .map(p => `set end of fileURLs to (current application's NSURL's fileURLWithPath:"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`)
    .join('\n');

  const script = `
use framework "AppKit"
use framework "Foundation"
set pb to current application's NSPasteboard's generalPasteboard()
pb's clearContents()
set fileURLs to {}
${urlLines}
pb's writeObjects:fileURLs
`;

  console.log('[clipboard-files] macOS write: using NSPasteboard for', filePaths);
  execSync(`osascript -l AppleScript -e '${script.replace(/'/g, "'\\''")}'`, {
    timeout: 5000,
  });

  // Verify: read back clipboard formats
  const formats = clipboard.availableFormats();
  console.log('[clipboard-files] macOS clipboard formats after write:', formats);

  return true;
}

/* ── Windows ───────────────────────────────────────────────────────── */

function readClipboardFilesWindows(): string[] | null {
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

  // Fallback: Electron may report text/uri-list with file:// URIs in the buffer
  const formats = clipboard.availableFormats();
  if (formats.includes('text/uri-list')) {
    const buf = clipboard.readBuffer('text/uri-list');
    const uriList = buf.toString('utf-8');
    console.log('[clipboard-files] Windows text/uri-list buffer:', JSON.stringify(uriList), `(${buf.length} bytes)`);
    if (uriList) {
      const paths = uriList
        .split('\n')
        .map(uri => uri.trim().replace(/\r$/, ''))
        .filter(uri => uri.startsWith('file:///'))
        .map(uri => {
          // Windows file URIs: file:///C:/path → C:\path
          const decoded = decodeURIComponent(new URL(uri).pathname);
          // Remove leading slash from /C:/path → C:/path, then normalize separators
          return decoded.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
        });
      console.log('[clipboard-files] Windows parsed URI paths:', paths);
      if (paths.length > 0) return paths;
    }
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

function readClipboardFilesLinux(): string[] | null {
  const formats = clipboard.availableFormats();
  if (!formats.includes('text/uri-list')) return null;

  const uriList = clipboard.readBuffer('text/uri-list').toString('utf-8');
  if (!uriList) return null;

  return parseFileUriList(uriList);
}

function writeClipboardFilesLinux(filePaths: string[]): boolean {
  const uriList = filePaths.map(p => `file://${encodeURI(p)}`).join('\r\n') + '\r\n';

  // Try xclip first, fall back to xsel
  try {
    execSync(`printf '%s' '${uriList.replace(/'/g, "'\\''")}' | xclip -selection clipboard -t text/uri-list`, {
      timeout: 5000,
    });
    return true;
  } catch {
    try {
      execSync(`printf '%s' '${uriList.replace(/'/g, "'\\''")}' | xsel --clipboard --input`, {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
}
