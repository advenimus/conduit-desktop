// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { classifyTarget, openTarget, type OpenTargetDeps } from '../open-target.js';

function makeDeps(overrides: Partial<OpenTargetDeps> = {}): OpenTargetDeps {
  return {
    openExternal: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn(),
    exists: vi.fn().mockReturnValue(true),
    homeDir: '/Users/test',
    ...overrides,
  };
}

describe('classifyTarget', () => {
  it('treats http, https and mailto as urls', () => {
    expect(classifyTarget('https://example.com/a?b=1')).toEqual({ kind: 'url', url: 'https://example.com/a?b=1' });
    expect(classifyTarget('http://localhost:3000')).toEqual({ kind: 'url', url: 'http://localhost:3000/' });
    expect(classifyTarget('mailto:a@b.co')).toEqual({ kind: 'url', url: 'mailto:a@b.co' });
  });

  it('rejects dangerous and unknown schemes', () => {
    expect(classifyTarget('javascript:alert(1)')).toBeNull();
    expect(classifyTarget('data:text/html,<b>x</b>')).toBeNull();
    expect(classifyTarget('vscode://file/etc/passwd')).toBeNull();
    expect(classifyTarget('ftp://example.com')).toBeNull();
  });

  it('converts file urls to paths', () => {
    expect(classifyTarget('file:///Users/test/My%20Docs/a.txt', '/Users/test')).toEqual({
      kind: 'path',
      path: '/Users/test/My Docs/a.txt',
    });
  });

  it('accepts absolute paths and expands ~', () => {
    expect(classifyTarget('/var/log/system.log', '/Users/test')).toEqual({ kind: 'path', path: '/var/log/system.log' });
    expect(classifyTarget('~/Downloads/x.pdf', '/Users/test')).toEqual({
      kind: 'path',
      path: path.join('/Users/test', 'Downloads/x.pdf'),
    });
    expect(classifyTarget('~', '/Users/test')).toEqual({ kind: 'path', path: '/Users/test' });
  });

  it('strips a trailing :line or :line:col', () => {
    expect(classifyTarget('/src/app.ts:42', '/h')).toEqual({ kind: 'path', path: '/src/app.ts' });
    expect(classifyTarget('/src/app.ts:42:7', '/h')).toEqual({ kind: 'path', path: '/src/app.ts' });
  });

  it('rejects relative paths and empty input', () => {
    expect(classifyTarget('src/app.ts')).toBeNull();
    expect(classifyTarget('./app.ts')).toBeNull();
    expect(classifyTarget('')).toBeNull();
    expect(classifyTarget('   ')).toBeNull();
  });

  it('rejects windows-style paths on a posix home (not supported)', () => {
    expect(classifyTarget('C:\\Windows\\notepad.exe')).toBeNull();
  });
});

describe('openTarget', () => {
  it('opens urls in the system browser', async () => {
    const deps = makeDeps();
    await openTarget('https://example.com', deps);
    expect(deps.openExternal).toHaveBeenCalledWith('https://example.com/');
    expect(deps.openPath).not.toHaveBeenCalled();
  });

  it('opens an existing file with the default app', async () => {
    const deps = makeDeps();
    await openTarget('/Users/test/notes.md:3', deps);
    expect(deps.exists).toHaveBeenCalledWith('/Users/test/notes.md');
    expect(deps.openPath).toHaveBeenCalledWith('/Users/test/notes.md');
  });

  it('opens a folder the same way', async () => {
    const deps = makeDeps();
    await openTarget('~/Downloads', deps);
    expect(deps.openPath).toHaveBeenCalledWith(path.join('/Users/test', 'Downloads'));
  });

  it('throws when the file does not exist', async () => {
    const deps = makeDeps({ exists: vi.fn().mockReturnValue(false) });
    await expect(openTarget('/nope/file.txt', deps)).rejects.toThrow(/does not exist/i);
    expect(deps.openPath).not.toHaveBeenCalled();
  });

  it('reveals executable-like files instead of running them', async () => {
    for (const name of ['/a/run.command', '/a/Tool.app', '/a/x.sh', '/a/y.EXE', '/a/z.bat', '/a/i.dmg']) {
      const deps = makeDeps();
      await openTarget(name, deps);
      expect(deps.showItemInFolder).toHaveBeenCalledWith(name);
      expect(deps.openPath).not.toHaveBeenCalled();
    }
  });

  it('throws the shell error message when openPath fails', async () => {
    const deps = makeDeps({ openPath: vi.fn().mockResolvedValue('no app') });
    await expect(openTarget('/a/b.txt', deps)).rejects.toThrow('no app');
  });

  it('refuses unsupported targets', async () => {
    const deps = makeDeps();
    await expect(openTarget('javascript:alert(1)', deps)).rejects.toThrow(/can't open/i);
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('defaults the home directory to the real one', () => {
    expect(classifyTarget('~')).toEqual({ kind: 'path', path: os.homedir() });
  });
});
