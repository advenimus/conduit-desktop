/**
 * Platform machine ids for hw_hint (spec 3.1): macOS IOPlatformUUID, Windows MachineGuid,
 * Linux /etc/machine-id or /var/lib/dbus/machine-id. OS access is injected (MachineIdIo) so
 * tests never read the real machine. Re-exported by identity.ts.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/** Injected OS access so tests never read real machine ids. */
export interface HwHintSources {
  readonly platform: NodeJS.Platform;
  /** macOS IOPlatformUUID, Windows MachineGuid, Linux /etc/machine-id or /var/lib/dbus/machine-id. */
  readonly readMachineId: () => string | null;
}

export interface MachineIdIo {
  /** File text, or null when the file does not exist. Other errors throw. */
  readonly readFile: (filePath: string) => string | null;
  /** stdout of a command; throws when the command cannot run or fails. */
  readonly exec: (file: string, args: readonly string[]) => string;
}

export const LINUX_MACHINE_ID_PATHS = ['/etc/machine-id', '/var/lib/dbus/machine-id'] as const;
export const MAC_IOREG_PATH = '/usr/sbin/ioreg';
export const MAC_IOREG_ARGS = ['-rd1', '-c', 'IOPlatformExpertDevice'] as const;
export const WIN_REG_EXE = 'reg';
/** /reg:64 so a 32-bit build still reads the 64-bit view, where MachineGuid lives. */
export const WIN_REG_ARGS = ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'] as const;

const EXEC_TIMEOUT_MS = 5000;
/** machine-id(5): 32 lowercase hex; "uninitialized" or empty during early boot or in containers. */
const LINUX_MACHINE_ID_RE = /^[0-9a-f]{32}$/;
const MAC_UUID_RE = /"IOPlatformUUID"\s*=\s*"([^"]+)"/;
const WIN_GUID_RE = /MachineGuid\s+REG_SZ\s+(\S+)/;

/** SHA-256 hex of the trimmed platform machine id, or null when the platform exposes none. */
export function readHwHint(sources: HwHintSources): string | null {
  const id = sources.readMachineId()?.trim() ?? '';
  return id === '' ? null : createHash('sha256').update(id, 'utf8').digest('hex');
}

export function readLinuxMachineId(io: MachineIdIo): string | null {
  for (const p of LINUX_MACHINE_ID_PATHS) {
    const text = io.readFile(p)?.trim() ?? '';
    if (LINUX_MACHINE_ID_RE.test(text)) return text;
  }
  return null;
}

export function readMacMachineId(io: MachineIdIo): string | null {
  const match = MAC_UUID_RE.exec(io.exec(MAC_IOREG_PATH, MAC_IOREG_ARGS));
  return match ? match[1].trim() || null : null;
}

export function readWindowsMachineId(io: MachineIdIo): string | null {
  const match = WIN_GUID_RE.exec(io.exec(WIN_REG_EXE, WIN_REG_ARGS));
  return match ? match[1].trim() || null : null;
}

/** The reader for `platform`; BSDs and other Unix-likes use the Linux files. */
export function machineIdReader(platform: NodeJS.Platform, io: MachineIdIo): () => string | null {
  if (platform === 'darwin') return () => readMacMachineId(io);
  if (platform === 'win32') return () => readWindowsMachineId(io);
  return () => readLinuxMachineId(io);
}

export function nodeMachineIdIo(): MachineIdIo {
  return {
    readFile: (filePath) => {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    exec: (file, args) =>
      execFileSync(file, [...args], {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
  };
}

export function defaultHwHintSources(
  platform: NodeJS.Platform = process.platform,
  io: MachineIdIo = nodeMachineIdIo(),
): HwHintSources {
  return { platform, readMachineId: machineIdReader(platform, io) };
}
