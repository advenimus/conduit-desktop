/**
 * Provider kind, location and file hint of a shared file (spec 5.8 "Different copies across
 * devices", 9.4 column limits): the kind comes from well-known folder names of iCloud Drive,
 * OneDrive, Dropbox, Google Drive and Box (including macOS ~/Library/CloudStorage), UNC and
 * network mounts. Pure; import through file-binding.ts.
 */

import path from 'node:path';
import type { FileBinding, FileHint } from './types.js';

/** 9.4 column limits (char_length, so counted in code points). */
export const LOCATION_MAX_LEN = 120;
export const FILE_NAME_MAX_LEN = 255;

export type ProviderKind = 'icloud' | 'onedrive' | 'dropbox' | 'gdrive' | 'box' | 'smb' | 'local' | 'other';

const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin']);
const CLOUD_STORAGE = 'CloudStorage';
const LOCATION_SEPARATOR = ':';
const UNC_PREFIXES = ['\\\\', '//'] as const;
const VOLUMES_DIR = 'Volumes';

interface Probe {
  /** Folder segments of the path (the file name itself excluded). */
  readonly segs: readonly string[];
  readonly fold: (s: string) => string;
}

function foldFor(platform: NodeJS.Platform): (s: string) => string {
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? (s) => s.toLowerCase() : (s) => s;
}

function probeOf(realpath: string, platform: NodeJS.Platform): Probe {
  const parts = realpath.split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter((s) => s !== '');
  return { segs: parts.slice(0, -1), fold: foldFor(platform) };
}

function anySeg(p: Probe, test: (seg: string, prev: string | null) => boolean): boolean {
  return p.segs.some((seg, i) => test(p.fold(seg), i > 0 ? p.fold(p.segs[i - 1] ?? '') : null));
}

function isCloudStorageChild(p: Probe, prev: string | null, seg: string, prefix: string): boolean {
  return prev === p.fold(CLOUD_STORAGE) && seg.startsWith(p.fold(prefix));
}

function isICloud(p: Probe): boolean {
  return anySeg(
    p,
    (seg, prev) =>
      (prev === p.fold('Library') && seg === p.fold('Mobile Documents')) ||
      seg === p.fold('CloudDocs') ||
      seg === p.fold('iCloudDrive') ||
      seg === p.fold('iCloud Drive'),
  );
}

function isOneDrive(p: Probe): boolean {
  return anySeg(p, (seg) => seg.startsWith(p.fold('OneDrive')));
}

function isDropbox(p: Probe): boolean {
  return anySeg(
    p,
    (seg, prev) => seg === p.fold('Dropbox') || seg.startsWith(p.fold('Dropbox (')) || isCloudStorageChild(p, prev, seg, 'Dropbox'),
  );
}

function isGoogleDrive(p: Probe): boolean {
  return anySeg(p, (seg, prev) => seg === p.fold('Google Drive') || isCloudStorageChild(p, prev, seg, 'GoogleDrive-'));
}

function isBox(p: Probe): boolean {
  return anySeg(p, (seg, prev) => seg === p.fold('Box') || seg === p.fold('Box Sync') || isCloudStorageChild(p, prev, seg, 'Box-'));
}

function isUnc(realpath: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && UNC_PREFIXES.some((prefix) => realpath.startsWith(prefix));
}

function isNetworkVolume(realpath: string, platform: NodeJS.Platform, isNetworkPath: (p: string) => boolean): boolean {
  if (platform === 'win32') return false;
  const segs = realpath.split('/').filter((s) => s !== '');
  return segs.length > 1 && foldFor(platform)(segs[0] ?? '') === foldFor(platform)(VOLUMES_DIR) && isNetworkPath(realpath);
}

/**
 * Provider of a realpath: iCloud (Mobile Documents, CloudDocs, iCloudDrive), OneDrive, Dropbox,
 * Google Drive (incl. ~/Library/CloudStorage/GoogleDrive-*), Box, SMB (UNC, /Volumes network
 * mounts via isNetworkPath), local, else other. Case-insensitive on win32/darwin.
 */
export function providerKindOf(realpath: string, platform: NodeJS.Platform, isNetworkPath: (p: string) => boolean): ProviderKind {
  const p = probeOf(realpath, platform);
  if (isICloud(p)) return 'icloud';
  if (isOneDrive(p)) return 'onedrive';
  if (isDropbox(p)) return 'dropbox';
  if (isGoogleDrive(p)) return 'gdrive';
  if (isBox(p)) return 'box';
  if (isUnc(realpath, platform) || isNetworkVolume(realpath, platform, isNetworkPath)) return 'smb';
  return isNetworkPath(realpath) ? 'other' : 'local';
}

/** Truncates to `max` code points (Postgres char_length), never splitting a surrogate pair. */
export function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** `<kind>:<parent folder name>`, truncated to LOCATION_MAX_LEN (5.8). */
export function locationOf(realpath: string, platform: NodeJS.Platform, isNetworkPath: (p: string) => boolean): string {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const parent = api.basename(api.dirname(realpath));
  return truncateChars(`${providerKindOf(realpath, platform, isNetworkPath)}${LOCATION_SEPARATOR}${parent}`, LOCATION_MAX_LEN);
}

/** Provider kind part of a location (`''` when the location is empty or has no kind). */
export function locationKind(location: string): string {
  const i = location.indexOf(LOCATION_SEPARATOR);
  return i < 0 ? location : location.slice(0, i);
}

export function fileHintOf(binding: FileBinding, platform: NodeJS.Platform, isNetworkPath: (p: string) => boolean): FileHint {
  const api = platform === 'win32' ? path.win32 : path.posix;
  return {
    file_id: binding.fileId,
    location: locationOf(binding.realpath, platform, isNetworkPath),
    file_name: truncateChars(api.basename(binding.realpath), FILE_NAME_MAX_LEN),
  };
}
