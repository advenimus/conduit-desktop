import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  has: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('electron', () => ({
  clipboard: { has: mocks.has, read: mocks.read, write: mocks.write },
  ClipboardItem: class {
    constructor(readonly data: Record<string, string>) {}
  },
}));

vi.mock('node:child_process', () => ({
  default: { execSync: mocks.execSync },
  execSync: mocks.execSync,
}));

const { clipboardCall, clipboardHasFiles, readClipboardFiles, writeClipboardFiles, parseFileUriList } = await import('../clipboard-files.js');

const URI_LIST = 'text/uri-list';
const NS_FILENAMES = 'electron application/osclipboard;format="NSFilenamesPboardType"';
const WIN_FILENAME_ANSI = 'electron application/osclipboard;format="FileName"';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function clipboardItem(data: Record<string, string>) {
  return {
    types: Object.keys(data),
    getType: vi.fn(async (type: string) => {
      if (!(type in data)) throw new Error(`The type '${type}' was not found in the ClipboardItem`);
      return new Blob([data[type]]);
    }),
  };
}

function givenAvailableTypes(types: string[]): void {
  mocks.has.mockImplementation(async (type: string) => types.includes(type));
}

function givenUriList(uriList: string): void {
  givenAvailableTypes([URI_LIST]);
  mocks.read.mockResolvedValue([clipboardItem({ [URI_LIST]: uriList })]);
}

beforeEach(() => {
  mocks.has.mockReset();
  mocks.read.mockReset();
  mocks.write.mockReset();
  mocks.execSync.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setPlatform(originalPlatform);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('parseFileUriList', () => {
  it('decodes POSIX file URIs and ignores CRLF line endings', () => {
    expect(parseFileUriList('file:///tmp/a.txt\r\nfile:///tmp/b%20c.txt\r\n', 'darwin'))
      .toEqual(['/tmp/a.txt', '/tmp/b c.txt']);
  });

  it('skips comments, blank lines, and non-file URIs', () => {
    expect(parseFileUriList('# copied\n\nhttps://example.com/x\nfile:///tmp/a.txt\n', 'linux'))
      .toEqual(['/tmp/a.txt']);
  });

  it('converts Windows drive-letter and UNC URIs to Windows paths', () => {
    expect(parseFileUriList('file:///C:/Users/me/a%20b.txt\r\nfile://server/share/f.txt', 'win32'))
      .toEqual(['C:\\Users\\me\\a b.txt', '\\\\server\\share\\f.txt']);
  });

  it('returns null when there are no file URIs', () => {
    expect(parseFileUriList('', 'darwin')).toBeNull();
    expect(parseFileUriList('https://example.com', 'darwin')).toBeNull();
  });
});

describe('clipboardHasFiles', () => {
  it('macOS: detects files from text/uri-list', async () => {
    setPlatform('darwin');
    givenAvailableTypes([URI_LIST]);
    await expect(clipboardHasFiles()).resolves.toBe(true);
  });

  it('macOS: detects files from the raw NSFilenamesPboardType format', async () => {
    setPlatform('darwin');
    givenAvailableTypes([NS_FILENAMES]);
    await expect(clipboardHasFiles()).resolves.toBe(true);
  });

  it('macOS: returns false for plain text', async () => {
    setPlatform('darwin');
    givenAvailableTypes(['text/plain']);
    await expect(clipboardHasFiles()).resolves.toBe(false);
  });

  it('Windows: detects files from text/uri-list (CF_HDROP)', async () => {
    setPlatform('win32');
    givenAvailableTypes([URI_LIST]);
    await expect(clipboardHasFiles()).resolves.toBe(true);
  });

  it('Windows: detects files from the raw ANSI FileName format', async () => {
    setPlatform('win32');
    givenAvailableTypes([WIN_FILENAME_ANSI]);
    await expect(clipboardHasFiles()).resolves.toBe(true);
  });

  it('Windows: returns false for plain text', async () => {
    setPlatform('win32');
    givenAvailableTypes(['text/plain']);
    await expect(clipboardHasFiles()).resolves.toBe(false);
  });

  it('Linux: requires at least one file:// URI in text/uri-list', async () => {
    setPlatform('linux');
    givenUriList('file:///home/me/a.txt\n');
    await expect(clipboardHasFiles()).resolves.toBe(true);

    givenUriList('https://example.com/\n');
    await expect(clipboardHasFiles()).resolves.toBe(false);
  });

  it('Linux: does not read the clipboard when text/uri-list is absent', async () => {
    setPlatform('linux');
    givenAvailableTypes(['text/plain']);
    await expect(clipboardHasFiles()).resolves.toBe(false);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('returns false when the clipboard API throws', async () => {
    setPlatform('darwin');
    mocks.has.mockRejectedValue(new Error('clipboard unavailable'));
    await expect(clipboardHasFiles()).resolves.toBe(false);
  });
});

describe('readClipboardFiles', () => {
  it('macOS: reads files via NSPasteboard first', async () => {
    setPlatform('darwin');
    mocks.execSync.mockReturnValue('/tmp/a.txt\n/tmp/b c.txt\n');
    givenUriList('file:///tmp/a.txt');

    await expect(readClipboardFiles()).resolves.toEqual(['/tmp/a.txt', '/tmp/b c.txt']);
    expect(mocks.execSync).toHaveBeenCalledWith(expect.stringContaining('osascript'), expect.anything());
  });

  it('macOS: falls back to Electron text/uri-list when NSPasteboard returns nothing', async () => {
    setPlatform('darwin');
    mocks.execSync.mockReturnValue('');
    givenUriList('file:///tmp/a.txt');

    await expect(readClipboardFiles()).resolves.toEqual(['/tmp/a.txt']);
  });

  it('macOS: falls back to Electron text/uri-list when osascript fails', async () => {
    setPlatform('darwin');
    mocks.execSync.mockImplementation(() => { throw new Error('osascript timed out'); });
    givenUriList('file:///tmp/a.txt');

    await expect(readClipboardFiles()).resolves.toEqual(['/tmp/a.txt']);
  });

  it('Windows: uses the PowerShell FileDropList first', async () => {
    setPlatform('win32');
    mocks.execSync.mockReturnValue('C:\\a.txt\r\nC:\\b c.txt\r\n');

    await expect(readClipboardFiles()).resolves.toEqual(['C:\\a.txt', 'C:\\b c.txt']);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('Windows: falls back to Electron text/uri-list when PowerShell fails', async () => {
    setPlatform('win32');
    mocks.execSync.mockImplementation(() => { throw new Error('powershell missing'); });
    givenUriList('file:///C:/Users/me/a%20b.txt\r\n');

    await expect(readClipboardFiles()).resolves.toEqual(['C:\\Users\\me\\a b.txt']);
  });

  it('Linux: reads paths from Electron text/uri-list', async () => {
    setPlatform('linux');
    givenUriList('file:///home/me/a.txt\r\nfile:///home/me/b%20c.txt\r\n');

    await expect(readClipboardFiles()).resolves.toEqual(['/home/me/a.txt', '/home/me/b c.txt']);
  });

  it('Linux: returns null when the clipboard has no file list', async () => {
    setPlatform('linux');
    givenAvailableTypes(['text/plain']);

    await expect(readClipboardFiles()).resolves.toBeNull();
  });

  it('returns null instead of throwing when the clipboard read fails', async () => {
    setPlatform('linux');
    givenAvailableTypes([URI_LIST]);
    mocks.read.mockRejectedValue(new Error('read failed'));

    await expect(readClipboardFiles()).resolves.toBeNull();
  });
});

describe('writeClipboardFiles', () => {
  it('macOS: writes every path as one text/uri-list through Electron', async () => {
    setPlatform('darwin');
    mocks.write.mockResolvedValue(undefined);

    await expect(writeClipboardFiles(['/tmp/a.txt', '/tmp/b c', '/tmp/dir'])).resolves.toBe(true);

    expect(mocks.write).toHaveBeenCalledTimes(1);
    const [items] = mocks.write.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(items[0].data).toEqual({ [URI_LIST]: 'file:///tmp/a.txt\r\nfile:///tmp/b%20c\r\nfile:///tmp/dir' });
    expect(mocks.execSync).not.toHaveBeenCalled();
  });

  it('macOS: returns false when the Electron write fails', async () => {
    setPlatform('darwin');
    mocks.write.mockRejectedValue(new Error('pasteboard locked'));

    await expect(writeClipboardFiles(['/tmp/a.txt'])).resolves.toBe(false);
  });

  it('Windows: still uses PowerShell Set-Clipboard', async () => {
    setPlatform('win32');

    await expect(writeClipboardFiles(['C:\\a.txt'])).resolves.toBe(true);

    expect(mocks.execSync).toHaveBeenCalledWith(expect.stringContaining('Set-Clipboard'), expect.anything());
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('Linux: detaches xclip output so its forked clipboard owner cannot block the write', async () => {
    setPlatform('linux');

    await expect(writeClipboardFiles(['/tmp/a.txt'])).resolves.toBe(true);

    expect(mocks.execSync).toHaveBeenCalledTimes(1);
    const [command, options] = mocks.execSync.mock.calls[0];
    expect(command).toContain('xclip -selection clipboard -t text/uri-list');
    expect(options).toMatchObject({ stdio: 'ignore' });
  });

  it('returns false for an empty list without touching the clipboard', async () => {
    await expect(writeClipboardFiles([])).resolves.toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.execSync).not.toHaveBeenCalled();
  });
});

describe('clipboardCall', () => {
  it('resolves with the result and leaves no timers behind', async () => {
    vi.useFakeTimers();
    await expect(clipboardCall(async () => 'value')).resolves.toBe('value');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects when the clipboard call never settles', async () => {
    vi.useFakeTimers();
    const pending = clipboardCall(() => new Promise<string>(() => {}), 1000);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the event loop busy while the call is pending', async () => {
    vi.useFakeTimers();
    let resolve!: (v: string) => void;
    const pending = clipboardCall(() => new Promise<string>(r => { resolve = r; }));
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);
    resolve('done');
    await expect(pending).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('stalled clipboard calls', () => {
  it('readClipboardFiles gives up instead of hanging when clipboard.read never settles', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    givenAvailableTypes([URI_LIST]);
    mocks.read.mockReturnValue(new Promise(() => {}));

    const pending = readClipboardFiles();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBeNull();
  });
});
