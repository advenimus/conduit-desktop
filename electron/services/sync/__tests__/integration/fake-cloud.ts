// FakeCloud adversary (spec 13.2): one server copy of S plus one mirror folder per device. A
// device's engine only ever sees its mirror; nothing moves unless the test says so. Supports
// delayed and reordered delivery (versions), silent last-writer-wins, provider-named and
// user-style copies, torn delivery, older/equal mtimes, in-place delivery, independent
// -wal/-shm delivery, the OneDrive rename dance, renames and Time-Machine-style mirror restores.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FakeClock } from '../host-fakes.js';

export type ConflictCopyStyle =
  | 'dropbox'
  | 'dropbox-user'
  | 'onedrive-host'
  | 'syncthing'
  | 'icloud'
  | 'gdrive'
  | 'user-2'
  | 'user-paren-1'
  | 'user-backup';

/** keep: the uploader's mtime; older: 1 h before the mirror's; equal: the mirror's; now: the clock. */
export type MtimeRule = 'keep' | 'older' | 'equal' | 'now';

export interface Version {
  readonly id: number;
  readonly bytes: Buffer;
  readonly mtimeMs: number;
  readonly from: string;
  readonly sha256: string;
}

export interface DownloadOptions {
  readonly mtime?: MtimeRule;
  /** A specific uploaded version (delayed or reordered delivery); default the server's current. */
  readonly version?: number;
  /** Overwrite S's bytes in place (same inode) instead of tmp + rename. */
  readonly inPlace?: boolean;
}

export interface FakeCloudOptions {
  readonly root: string;
  readonly clock: FakeClock;
  readonly fileName?: string;
}

const HOUR_MS = 60 * 60 * 1000;
const COPY_DATE = '2026-09-25';
const SHM_BYTES = 32768;

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Provider-style (5.8) and user-style conflict copy names for stem `stem`. */
export function copyName(stem: string, style: ConflictCopyStyle, host = 'DESKTOP-ABC'): string {
  switch (style) {
    case 'dropbox':
      return `${stem} (conflicted copy ${COPY_DATE}).conduit`;
    case 'dropbox-user':
      return `${stem} (Chris's conflicted copy ${COPY_DATE}).conduit`;
    case 'onedrive-host':
      return `${stem}-${host}.conduit`;
    case 'syncthing':
      return `${stem}.sync-conflict-20260925-120000-ABCDEFG.conduit`;
    case 'icloud':
    case 'user-2':
      return `${stem} 2.conduit`;
    case 'gdrive':
    case 'user-paren-1':
      return `${stem} (1).conduit`;
    case 'user-backup':
      return `${stem} backup.conduit`;
  }
}

export class FakeCloud {
  readonly fileName: string;
  private readonly versions: Version[] = [];
  private readonly snapshots = new Map<string, Map<string, { readonly bytes: Buffer; readonly mtimeMs: number }>>();
  private readonly mirrors = new Set<string>();

  constructor(private readonly opts: FakeCloudOptions) {
    this.fileName = opts.fileName ?? 'Vault.conduit';
    fs.mkdirSync(path.join(opts.root, 'server'), { recursive: true });
  }

  get stem(): string {
    return this.fileName.replace(/\.conduit$/i, '');
  }

  mirror(device: string): string {
    const dir = path.join(this.opts.root, 'mirrors', device);
    fs.mkdirSync(dir, { recursive: true });
    this.mirrors.add(device);
    return dir;
  }

  sharedPath(device: string): string {
    return path.join(this.mirror(device), this.fileName);
  }

  devices(): string[] {
    return [...this.mirrors];
  }

  /** The server's current version (null before the first upload). */
  current(): Version | null {
    return this.versions[this.versions.length - 1] ?? null;
  }

  version(id: number): Version {
    const v = this.versions.find((x) => x.id === id);
    if (v === undefined) throw new Error(`FakeCloud: no version ${id}`);
    return v;
  }

  /** Uploads the device's S when it differs from the server's; last upload wins silently. */
  upload(device: string): Version | null {
    const file = this.sharedPath(device);
    if (!fs.existsSync(file)) return null;
    const bytes = fs.readFileSync(file);
    const hash = sha256(bytes);
    if (this.current()?.sha256 === hash) return null;
    const v: Version = { id: this.versions.length + 1, bytes, mtimeMs: fs.statSync(file).mtimeMs, from: device, sha256: hash };
    this.versions.push(v);
    return v;
  }

  /** Writes a server version into the device's mirror; false when the mirror already has it. */
  download(device: string, o: DownloadOptions = {}): boolean {
    const v = o.version === undefined ? this.current() : this.version(o.version);
    if (v === null) return false;
    const file = this.sharedPath(device);
    const prev = fs.existsSync(file) ? fs.statSync(file) : null;
    if (prev !== null && sha256(fs.readFileSync(file)) === v.sha256 && o.mtime === undefined) return false;
    this.writeMirror(file, v.bytes, o.inPlace === true);
    this.touch(file, this.mtimeFor(v, prev?.mtimeMs ?? null, o.mtime ?? 'keep'));
    return true;
  }

  /** upload(from), then download to every other mirror. */
  sync(from: string, mtime: MtimeRule = 'keep'): void {
    this.upload(from);
    for (const d of this.mirrors) if (d !== from) this.download(d, { mtime });
  }

  /** Writes `bytes` (default: the server's current) under a conflict-copy name in the mirror. */
  conflictCopy(device: string, style: ConflictCopyStyle, bytes?: Buffer, host?: string): string {
    const data = bytes ?? this.current()?.bytes;
    if (data === undefined) throw new Error('FakeCloud: nothing to copy');
    const file = path.join(this.mirror(device), copyName(this.stem, style, host));
    fs.writeFileSync(file, data);
    this.touch(file);
    return file;
  }

  /** Only the first `fraction` of the server's bytes reach the device's S (torn download). */
  tornDownload(device: string, fraction: number): void {
    const v = this.current();
    if (v === null) throw new Error('FakeCloud: nothing to download');
    const cut = Math.max(1, Math.floor(v.bytes.length * fraction));
    fs.writeFileSync(this.sharedPath(device), v.bytes.subarray(0, cut));
    this.touch(this.sharedPath(device));
  }

  /** Puts -wal/-shm next to the device's S (an empty WAL when walBytes is 0). */
  addSideFiles(device: string, walBytes: number): void {
    const s = this.sharedPath(device);
    fs.writeFileSync(`${s}-wal`, crypto.randomBytes(walBytes));
    fs.writeFileSync(`${s}-shm`, Buffer.alloc(SHM_BYTES));
    this.touch(`${s}-wal`);
    this.touch(`${s}-shm`);
  }

  /** Independent side-file delivery: copies whatever -wal/-shm `from` has to `to`. */
  copySideFiles(from: string, to: string): number {
    let n = 0;
    for (const suffix of ['-wal', '-shm']) {
      const src = `${this.sharedPath(from)}${suffix}`;
      if (!fs.existsSync(src)) continue;
      const dst = `${this.sharedPath(to)}${suffix}`;
      fs.copyFileSync(src, dst);
      fs.utimesSync(dst, new Date(), fs.statSync(src).mtime);
      n += 1;
    }
    return n;
  }

  removeSideFiles(device: string): void {
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${this.sharedPath(device)}${suffix}`, { force: true });
  }

  /** OneDrive rename dance, first half: S becomes `<stem>-<host>.conduit`. putBack() is the second half. */
  renameDance(device: string, host: string): string {
    const target = path.join(this.mirror(device), copyName(this.stem, 'onedrive-host', host));
    fs.renameSync(this.sharedPath(device), target);
    return target;
  }

  /** The server version returns at S's name. */
  putBack(device: string): void {
    const v = this.current();
    if (v === null) throw new Error('FakeCloud: nothing to put back');
    fs.writeFileSync(this.sharedPath(device), v.bytes);
    this.touch(this.sharedPath(device));
  }

  /** A rename made elsewhere: the server file and every mirror's S get `newName`. */
  renameEverywhere(newName: string): void {
    for (const d of this.mirrors) {
      const from = this.sharedPath(d);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(this.mirror(d), newName));
    }
  }

  /** Saves the mirror's files for restoreMirror (Time Machine). */
  snapshotMirror(device: string): string {
    const id = `${device}-${this.snapshots.size + 1}`;
    const dir = this.mirror(device);
    const files = new Map<string, { readonly bytes: Buffer; readonly mtimeMs: number }>();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (!fs.statSync(file).isFile()) continue;
      files.set(name, { bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs });
    }
    this.snapshots.set(id, files);
    return id;
  }

  restoreMirror(device: string, id: string): void {
    const files = this.snapshots.get(id);
    if (files === undefined) throw new Error(`FakeCloud: no snapshot ${id}`);
    const dir = this.mirror(device);
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true, recursive: true });
    for (const [name, f] of files) {
      fs.writeFileSync(path.join(dir, name), f.bytes);
      this.touch(path.join(dir, name), f.mtimeMs);
    }
  }

  /** Files the cloud writes carry simulated time, not the real wall clock. */
  touch(file: string, ms: number = this.opts.clock.now()): void {
    fs.utimesSync(file, new Date(ms), new Date(ms));
  }

  private writeMirror(file: string, bytes: Buffer, inPlace: boolean): void {
    if (inPlace && fs.existsSync(file)) {
      const fd = fs.openSync(file, 'r+');
      try {
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, bytes, 0, bytes.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      return;
    }
    const tmp = `${file}.cloud-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
  }

  private mtimeFor(v: Version, mirrorMtime: number | null, rule: MtimeRule): number {
    switch (rule) {
      case 'keep':
        return v.mtimeMs;
      case 'older':
        return (mirrorMtime ?? v.mtimeMs) - HOUR_MS;
      case 'equal':
        return mirrorMtime ?? v.mtimeMs;
      case 'now':
        return this.opts.clock.now();
    }
  }
}
