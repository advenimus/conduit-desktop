import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  readText: vi.fn(),
  writeText: vi.fn(),
  clipboardHasFiles: vi.fn(),
  readClipboardFiles: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  clipboard: { readText: mocks.readText, writeText: mocks.writeText },
}));

vi.mock('sharp', () => ({ default: vi.fn() }));

vi.mock('../engines/factory.js', () => ({ createRdpEngine: vi.fn() }));

vi.mock('../clipboard-files.js', () => ({
  clipboardCall: <T>(op: () => Promise<T>) => Promise.race([
    op(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Clipboard call timed out')), 5000)),
  ]),
  clipboardHasFiles: mocks.clipboardHasFiles,
  readClipboardFiles: mocks.readClipboardFiles,
  writeClipboardFiles: vi.fn(),
}));

const { RdpSession } = await import('../session.js');

interface FakeEngine {
  nativeClipboardActive: boolean;
  sendClipboard: ReturnType<typeof vi.fn>;
  sendClipboardFiles: ReturnType<typeof vi.fn>;
}

function connectedSession(): { session: InstanceType<typeof RdpSession>; engine: FakeEngine } {
  const session = new RdpSession('test', {
    host: 'example.test',
    port: 3389,
    username: 'u',
    password: 'p',
    width: 800,
    height: 600,
    enableNla: false,
    skipCertVerification: true,
  });
  const engine: FakeEngine = {
    nativeClipboardActive: false,
    sendClipboard: vi.fn(),
    sendClipboardFiles: vi.fn(),
  };
  const internals = session as unknown as { engine: FakeEngine | null; state: string };
  internals.engine = engine;
  internals.state = 'connected';
  return { session, engine };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-rdp-clip-'));
  mocks.readText.mockReset();
  mocks.writeText.mockReset();
  mocks.clipboardHasFiles.mockReset();
  mocks.readClipboardFiles.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RdpSession.syncLocalClipboardToRemote', () => {
  it('sends clipboard text using the async clipboard API', async () => {
    const { session, engine } = connectedSession();
    mocks.clipboardHasFiles.mockResolvedValue(false);
    mocks.readText.mockResolvedValue('hello remote');

    await session.syncLocalClipboardToRemote();

    expect(engine.sendClipboard).toHaveBeenCalledWith('hello remote');
    expect(engine.sendClipboardFiles).not.toHaveBeenCalled();
  });

  it('sends copied files instead of text', async () => {
    const { session, engine } = connectedSession();
    const file = path.join(tmpDir, 'report.txt');
    fs.writeFileSync(file, 'abc');
    mocks.clipboardHasFiles.mockResolvedValue(true);
    mocks.readClipboardFiles.mockResolvedValue([file]);

    await session.syncLocalClipboardToRemote();

    expect(engine.sendClipboardFiles).toHaveBeenCalledWith([
      { path: file, name: 'report.txt', size: 3, isDirectory: false },
    ]);
    expect(mocks.readText).not.toHaveBeenCalled();
  });

  it('runs overlapping syncs one at a time so duplicate files are sent once', async () => {
    const { session, engine } = connectedSession();
    const file = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(file, 'a');
    mocks.clipboardHasFiles.mockResolvedValue(true);
    mocks.readClipboardFiles.mockResolvedValue([file]);

    await Promise.all([session.syncLocalClipboardToRemote(), session.syncLocalClipboardToRemote()]);

    expect(engine.sendClipboardFiles).toHaveBeenCalledTimes(1);
  });

  it('stops quietly if the session disconnects while the clipboard is being read', async () => {
    const { session, engine } = connectedSession();
    mocks.clipboardHasFiles.mockImplementation(async () => {
      (session as unknown as { engine: FakeEngine | null }).engine = null;
      return false;
    });
    mocks.readText.mockResolvedValue('late text');

    await expect(session.syncLocalClipboardToRemote()).resolves.toBeUndefined();
    expect(engine.sendClipboard).not.toHaveBeenCalled();
  });

  it('keeps working after a failed clipboard read', async () => {
    const { session, engine } = connectedSession();
    mocks.clipboardHasFiles.mockResolvedValue(false);
    mocks.readText.mockRejectedValueOnce(new Error('pasteboard busy')).mockResolvedValueOnce('second try');

    await expect(session.syncLocalClipboardToRemote()).resolves.toBeUndefined();
    await session.syncLocalClipboardToRemote();

    expect(engine.sendClipboard).toHaveBeenCalledTimes(1);
    expect(engine.sendClipboard).toHaveBeenCalledWith('second try');
  });
});

describe('RdpSession clipboard changes during a sync', () => {
  it('does not echo local text back when remote text arrives mid-sync', async () => {
    const { session, engine } = connectedSession();
    mocks.writeText.mockResolvedValue(undefined);
    mocks.clipboardHasFiles.mockImplementation(async () => {
      (session as unknown as { handleRemoteClipboard(text: string): void }).handleRemoteClipboard('copied on remote');
      return false;
    });
    mocks.readText.mockResolvedValue('stale local text');

    await session.syncLocalClipboardToRemote();

    expect(engine.sendClipboard).not.toHaveBeenCalled();
  });

  it('does not claim the remote clipboard when remote files arrive mid-sync', async () => {
    const { session, engine } = connectedSession();
    const file = path.join(tmpDir, 'local.txt');
    fs.writeFileSync(file, 'x');
    mocks.clipboardHasFiles.mockResolvedValue(true);
    mocks.readClipboardFiles.mockImplementation(async () => {
      (session as unknown as { remoteFiles: unknown[] }).remoteFiles = [{ name: 'remote.txt', size: 1 }];
      return [file];
    });

    await session.syncLocalClipboardToRemote();

    expect(engine.sendClipboardFiles).not.toHaveBeenCalled();
  });
});

describe('RdpSession clipboard stalls', () => {
  it('a clipboard read that never settles does not block later syncs', async () => {
    vi.useFakeTimers();
    const { session, engine } = connectedSession();
    mocks.clipboardHasFiles.mockResolvedValue(false);
    mocks.readText.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce('after stall');

    const first = session.syncLocalClipboardToRemote();
    const second = session.syncLocalClipboardToRemote();
    await vi.advanceTimersByTimeAsync(6000);
    await Promise.all([first, second]);

    expect(engine.sendClipboard).toHaveBeenCalledTimes(1);
    expect(engine.sendClipboard).toHaveBeenCalledWith('after stall');
  });
});

describe('RdpSession echo suppression', () => {
  it('keeps suppressing local syncs until a slow remote-text write finishes, then 2s more', async () => {
    vi.useFakeTimers();
    const { session, engine } = connectedSession();
    let finishWrite!: () => void;
    mocks.writeText.mockReturnValue(new Promise<void>(resolve => { finishWrite = resolve; }));
    mocks.clipboardHasFiles.mockResolvedValue(false);
    mocks.readText.mockResolvedValue('copied on remote');

    (session as unknown as { handleRemoteClipboard(text: string): void }).handleRemoteClipboard('copied on remote');

    await vi.advanceTimersByTimeAsync(3000);
    await session.syncLocalClipboardToRemote();
    expect(engine.sendClipboard).not.toHaveBeenCalled();

    finishWrite();
    await vi.advanceTimersByTimeAsync(1500);
    await session.syncLocalClipboardToRemote();
    expect(engine.sendClipboard).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await session.syncLocalClipboardToRemote();
    expect(engine.sendClipboard).toHaveBeenCalledWith('copied on remote');
  });
});

describe('RdpSession remote clipboard text', () => {
  it('writes remote text to the local clipboard and logs a failed write instead of rejecting', async () => {
    const { session } = connectedSession();
    mocks.writeText.mockRejectedValue(new Error('write denied'));

    (session as unknown as { handleRemoteClipboard(text: string): void }).handleRemoteClipboard('from remote');
    await new Promise(resolve => setImmediate(resolve));

    expect(mocks.writeText).toHaveBeenCalledWith('from remote');
    expect(console.error).toHaveBeenCalled();
  });
});
