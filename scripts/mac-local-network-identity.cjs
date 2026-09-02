/**
 * Shared Local Network identity for the packaged app and the npm Electron.dev
 * stamp. macOS keys the permission on code signature + main-executable LC_UUID.
 * Every Electron 41.x stub shares the same UUID, so we rewrite it to a value
 * derived from the bundle id before signing.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROD_BUNDLE_ID = 'com.conduit.app';
const DEV_BUNDLE_ID = 'com.conduit.app.dev';
const DEV_PRODUCT_NAME = 'Conduit Dev';
const LOCAL_NETWORK_USAGE_DESCRIPTION =
  'Conduit needs access to your local network to connect to devices via SSH, RDP, VNC, and web sessions.';

const MH_MAGIC_64 = 0xfeedfacf;
const MH_MAGIC = 0xfeedface;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_UUID = 0x1b;

function deriveUuidBytes(seed) {
  const hash = crypto.createHash('sha1').update(`conduit-local-network|${seed}`).digest();
  const uuid = Buffer.from(hash.subarray(0, 16));
  uuid[6] = (uuid[6] & 0x0f) | 0x50;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  return uuid;
}

function formatUuid(bytes) {
  const hex = Buffer.from(bytes).toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readU32(buf, offset, le) {
  return le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

function findUuidOffsetsInSlice(buf, sliceStart, sliceSize, le, is64) {
  const headerSize = is64 ? 32 : 28;
  const base = sliceStart;
  if (sliceSize < headerSize) return [];
  const ncmds = readU32(buf, base + 16, le);
  let off = base + headerSize;
  const end = base + sliceSize;
  const offsets = [];
  for (let i = 0; i < ncmds; i += 1) {
    if (off + 8 > end) break;
    const cmd = readU32(buf, off, le);
    const cmdsize = readU32(buf, off + 4, le);
    if (cmdsize < 8) break;
    if (cmd === LC_UUID && off + 24 <= end) {
      offsets.push(off + 8);
    }
    off += cmdsize;
  }
  return offsets;
}

function findFatUuidOffsets(buf, is64) {
  if (buf.length < 8) return [];
  const narch = buf.readUInt32BE(4);
  const archSize = is64 ? 32 : 20;
  const offsets = [];
  for (let i = 0; i < narch; i += 1) {
    const entry = 8 + i * archSize;
    if (entry + archSize > buf.length) break;
    const sliceOff = is64
      ? Number(buf.readBigUInt64BE(entry + 8))
      : buf.readUInt32BE(entry + 8);
    const sliceSize = is64
      ? Number(buf.readBigUInt64BE(entry + 16))
      : buf.readUInt32BE(entry + 12);
    if (sliceOff < 0 || sliceSize < 32 || sliceOff + sliceSize > buf.length) continue;
    const slice = buf.subarray(sliceOff, sliceOff + sliceSize);
    const inner = findUuidOffsets(slice).map((offset) => offset + sliceOff);
    offsets.push(...inner);
  }
  return offsets;
}

function findUuidOffsets(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) return [];
  const be = buffer.readUInt32BE(0);
  if (be === FAT_MAGIC || be === FAT_MAGIC_64) {
    return findFatUuidOffsets(buffer, be === FAT_MAGIC_64);
  }
  const le = buffer.readUInt32LE(0);
  if (le === MH_MAGIC_64) return findUuidOffsetsInSlice(buffer, 0, buffer.length, true, true);
  if (le === MH_MAGIC) return findUuidOffsetsInSlice(buffer, 0, buffer.length, true, false);
  if (be === MH_MAGIC_64) return findUuidOffsetsInSlice(buffer, 0, buffer.length, false, true);
  if (be === MH_MAGIC) return findUuidOffsetsInSlice(buffer, 0, buffer.length, false, false);
  return [];
}

function withPatchedUuids(buffer, uuidBytes) {
  if (!Buffer.isBuffer(uuidBytes) || uuidBytes.length !== 16) {
    throw new Error('uuidBytes must be 16 bytes');
  }
  const offsets = findUuidOffsets(buffer);
  if (offsets.length === 0) {
    throw new Error('Mach-O has no LC_UUID to patch');
  }
  const patched = Buffer.from(buffer);
  for (const offset of offsets) {
    uuidBytes.copy(patched, offset);
  }
  return patched;
}

function writePatchedUuid(filePath, uuidBytes) {
  const original = fs.readFileSync(filePath);
  const patched = withPatchedUuids(original, uuidBytes);
  fs.writeFileSync(filePath, patched);
}

function devInfoPlistUpdates() {
  return {
    CFBundleIdentifier: DEV_BUNDLE_ID,
    CFBundleName: DEV_PRODUCT_NAME,
    CFBundleDisplayName: DEV_PRODUCT_NAME,
    NSLocalNetworkUsageDescription: LOCAL_NETWORK_USAGE_DESCRIPTION,
  };
}

function devAppInstallPath(homeDir = os.homedir()) {
  return path.join(homeDir, 'Applications', `${DEV_PRODUCT_NAME}.app`);
}

module.exports = {
  PROD_BUNDLE_ID,
  DEV_BUNDLE_ID,
  DEV_PRODUCT_NAME,
  LOCAL_NETWORK_USAGE_DESCRIPTION,
  deriveUuidBytes,
  formatUuid,
  findUuidOffsets,
  withPatchedUuids,
  writePatchedUuid,
  devInfoPlistUpdates,
  devAppInstallPath,
};
