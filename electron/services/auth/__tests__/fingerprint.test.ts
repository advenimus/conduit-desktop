// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }));

const { LINUX_MACHINE_ID_PATHS, readLinuxMachineId } = await import('../fingerprint.js');

const ID_A = '0123456789abcdef0123456789abcdef';
const ID_B = 'fedcba9876543210fedcba9876543210';

function files(map: Record<string, string>) {
  return (p: string): string => {
    if (!(p in map)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return map[p];
  };
}

describe('Linux machine id', () => {
  it('reads /etc/machine-id first', () => {
    const read = files({ [LINUX_MACHINE_ID_PATHS[0]]: `${ID_A}\n`, [LINUX_MACHINE_ID_PATHS[1]]: ID_B });
    expect(readLinuxMachineId(read)).toBe(ID_A);
  });

  it('falls back to the D-Bus machine id', () => {
    expect(readLinuxMachineId(files({ [LINUX_MACHINE_ID_PATHS[1]]: ID_B.toUpperCase() }))).toBe(ID_B);
  });

  it('skips empty or malformed ids and returns empty when none is valid', () => {
    expect(readLinuxMachineId(files({ [LINUX_MACHINE_ID_PATHS[0]]: 'uninitialized', [LINUX_MACHINE_ID_PATHS[1]]: ID_B }))).toBe(ID_B);
    expect(readLinuxMachineId(files({ [LINUX_MACHINE_ID_PATHS[0]]: '' }))).toBe('');
    expect(readLinuxMachineId(files({}))).toBe('');
  });
});
