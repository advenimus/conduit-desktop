import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const identity = require('../mac-local-network-identity.cjs') as {
  DEV_BUNDLE_ID: string;
  DEV_PRODUCT_NAME: string;
  PROD_BUNDLE_ID: string;
  LOCAL_NETWORK_USAGE_DESCRIPTION: string;
  deriveUuidBytes: (seed: string) => Buffer;
  formatUuid: (bytes: Buffer) => string;
  findUuidOffsets: (buffer: Buffer) => number[];
  withPatchedUuids: (buffer: Buffer, uuidBytes: Buffer) => Buffer;
  writePatchedUuid: (filePath: string, uuidBytes: Buffer) => void;
  devInfoPlistUpdates: () => Record<string, string>;
};

const LC_UUID = 0x1b;
const MH_MAGIC_64 = 0xfeedfacf;

function thinArm64WithUuid(uuid: Buffer): Buffer {
  const ncmds = 1;
  const sizeofcmds = 24;
  const buf = Buffer.alloc(32 + sizeofcmds);
  buf.writeUInt32LE(MH_MAGIC_64, 0);
  buf.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  buf.writeUInt32LE(0, 8);
  buf.writeUInt32LE(2, 12); // MH_EXECUTE
  buf.writeUInt32LE(ncmds, 16);
  buf.writeUInt32LE(sizeofcmds, 20);
  buf.writeUInt32LE(0, 24);
  buf.writeUInt32LE(0, 28);
  buf.writeUInt32LE(LC_UUID, 32);
  buf.writeUInt32LE(24, 36);
  uuid.copy(buf, 40);
  return buf;
}

describe('mac local-network identity', () => {
  it('keeps the packaged bundle id distinct from the dev Electron stamp', () => {
    expect(identity.PROD_BUNDLE_ID).toBe('com.conduit.app');
    expect(identity.DEV_BUNDLE_ID).toBe('com.conduit.app.dev');
    expect(identity.DEV_PRODUCT_NAME).toBe('Conduit Dev');
    expect(identity.DEV_BUNDLE_ID).not.toBe(identity.PROD_BUNDLE_ID);
  });

  it('uses the same usage string the packaged app ships', () => {
    expect(identity.LOCAL_NETWORK_USAGE_DESCRIPTION).toMatch(/local network/i);
    expect(identity.LOCAL_NETWORK_USAGE_DESCRIPTION).toMatch(/SSH/);
  });

  it('derives a stable 16-byte UUID from the bundle id', () => {
    const a = identity.deriveUuidBytes(identity.PROD_BUNDLE_ID);
    const b = identity.deriveUuidBytes(identity.PROD_BUNDLE_ID);
    const dev = identity.deriveUuidBytes(identity.DEV_BUNDLE_ID);
    expect(a).toHaveLength(16);
    expect(Buffer.compare(a, b)).toBe(0);
    expect(Buffer.compare(a, dev)).not.toBe(0);
  });

  it('does not collide with Electron 41.10.4\'s stock LC_UUID', () => {
    const stock = '4C4C4461-5555-3144-A1D9-15C795D7EB04';
    expect(identity.formatUuid(identity.deriveUuidBytes(identity.PROD_BUNDLE_ID))).not.toBe(stock);
    expect(identity.formatUuid(identity.deriveUuidBytes(identity.DEV_BUNDLE_ID))).not.toBe(stock);
  });

  it('replaces LC_UUID on a thin arm64 Mach-O without mutating the original', () => {
    const originalUuid = Buffer.from('0123456789abcdeffedcba9876543210', 'hex');
    const original = thinArm64WithUuid(originalUuid);
    const snapshot = Buffer.from(original);
    const next = identity.deriveUuidBytes('test.seed');

    const patched = identity.withPatchedUuids(original, next);

    expect(Buffer.compare(original, snapshot)).toBe(0);
    expect(identity.findUuidOffsets(original)).toEqual([40]);
    expect(patched.subarray(40, 56).equals(next)).toBe(true);
    expect(patched.subarray(40, 56).equals(originalUuid)).toBe(false);
  });

  it('throws when the buffer has no LC_UUID', () => {
    const empty = Buffer.alloc(64);
    empty.writeUInt32LE(MH_MAGIC_64, 0);
    empty.writeUInt32LE(0, 16); // ncmds
    expect(() => identity.withPatchedUuids(empty, identity.deriveUuidBytes('x'))).toThrow(/LC_UUID/);
  });

  it('writes a patched copy to disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-uuid-'));
    const file = path.join(dir, 'Conduit');
    const originalUuid = Buffer.alloc(16, 1);
    fs.writeFileSync(file, thinArm64WithUuid(originalUuid));
    const next = identity.deriveUuidBytes(identity.DEV_BUNDLE_ID);

    identity.writePatchedUuid(file, next);

    const written = fs.readFileSync(file);
    expect(written.subarray(40, 56).equals(next)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names the Info.plist keys macOS needs to prompt in Electron.dev', () => {
    const updates = identity.devInfoPlistUpdates();
    expect(updates.CFBundleIdentifier).toBe(identity.DEV_BUNDLE_ID);
    expect(updates.CFBundleName).toBe(identity.DEV_PRODUCT_NAME);
    expect(updates.CFBundleDisplayName).toBe(identity.DEV_PRODUCT_NAME);
    expect(updates.NSLocalNetworkUsageDescription).toBe(identity.LOCAL_NETWORK_USAGE_DESCRIPTION);
  });

  it('installs the Launch Services copy under ~/Applications', () => {
    expect(identity.devAppInstallPath('/Users/chris')).toBe(
      '/Users/chris/Applications/Conduit Dev.app',
    );
  });
});

const electronStub = path.join(
  process.cwd(),
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
);

describe.skipIf(!fs.existsSync(electronStub))('real Electron stub', () => {
  it('finds an LC_UUID on the npm Electron binary', () => {
    const buf = fs.readFileSync(electronStub);
    const offsets = identity.findUuidOffsets(buf);
    expect(offsets.length).toBeGreaterThan(0);
    const uuid = buf.subarray(offsets[0], offsets[0] + 16);
    expect(identity.formatUuid(uuid)).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  });
});
