import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { pruneNativePrebuilds } = require('../prune-native-prebuilds.cjs') as {
  pruneNativePrebuilds(nodeModulesDir: string, platform: string, arch: string): string[];
};

const LAYOUT: Record<string, string[]> = {
  'better-sqlite3/prebuilds': [
    'darwin-arm64.node', 'darwin-x64.node', 'linux-arm64.node', 'linux-x64.node',
    'linuxmusl-x64.node', 'win32-arm64.node', 'win32-x64.node',
  ],
  'node-pty/prebuilds': ['darwin-arm64/pty.node', 'darwin-x64/pty.node', 'win32-x64/pty.node', 'win32-arm64/pty.node'],
  'koffi/build/koffi': ['darwin_arm64/koffi.node', 'darwin_x64/koffi.node', 'linux_x64/koffi.node', 'win32_x64/koffi.node', 'freebsd_x64/koffi.node'],
};

let modules: string;

beforeEach(() => {
  modules = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-prune-'));
  for (const [dir, entries] of Object.entries(LAYOUT)) {
    for (const entry of entries) {
      const file = path.join(modules, dir, entry);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'bin');
    }
  }
});

afterEach(() => {
  fs.rmSync(modules, { recursive: true, force: true });
});

const remaining = (dir: string) => fs.readdirSync(path.join(modules, dir)).sort();

describe('pruneNativePrebuilds', () => {
  it('keeps only the macOS arm64 binaries on a Mac build', () => {
    pruneNativePrebuilds(modules, 'darwin', 'arm64');
    expect(remaining('better-sqlite3/prebuilds')).toEqual(['darwin-arm64.node']);
    expect(remaining('node-pty/prebuilds')).toEqual(['darwin-arm64']);
    expect(remaining('koffi/build/koffi')).toEqual(['darwin_arm64']);
  });

  it('keeps only the Windows x64 binaries on a Windows build', () => {
    pruneNativePrebuilds(modules, 'win32', 'x64');
    expect(remaining('better-sqlite3/prebuilds')).toEqual(['win32-x64.node']);
    expect(remaining('node-pty/prebuilds')).toEqual(['win32-x64']);
    expect(remaining('koffi/build/koffi')).toEqual(['win32_x64']);
  });

  it('keeps only the Linux x64 binaries on a Linux build', () => {
    pruneNativePrebuilds(modules, 'linux', 'x64');
    expect(remaining('better-sqlite3/prebuilds')).toEqual(['linux-x64.node']);
    expect(remaining('node-pty/prebuilds')).toEqual([]);
    expect(remaining('koffi/build/koffi')).toEqual(['linux_x64']);
  });

  it('reports what it removed', () => {
    const removed = pruneNativePrebuilds(modules, 'darwin', 'arm64');
    expect(removed).toContain(path.join('better-sqlite3', 'prebuilds', 'win32-x64.node'));
    expect(removed).not.toContain(path.join('better-sqlite3', 'prebuilds', 'darwin-arm64.node'));
  });

  it('refuses to prune when the target binary is missing, so a build never ships without one', () => {
    fs.rmSync(path.join(modules, 'better-sqlite3/prebuilds/darwin-arm64.node'));
    expect(() => pruneNativePrebuilds(modules, 'darwin', 'arm64')).toThrow(/better-sqlite3/);
    expect(remaining('better-sqlite3/prebuilds')).toContain('win32-x64.node');
  });

  it('skips packages that are not installed', () => {
    fs.rmSync(path.join(modules, 'koffi'), { recursive: true });
    expect(() => pruneNativePrebuilds(modules, 'darwin', 'arm64')).not.toThrow();
  });
});
