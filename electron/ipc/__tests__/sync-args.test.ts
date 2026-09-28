// @vitest-environment node
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InvalidSyncRequest,
  argsObject,
  optionalBoolean,
  optionalVaultTarget,
  requireFilePath,
  requireList,
  requirePassword,
  requireVaultTarget,
} from '../sync-args.js';

const ABS = path.resolve('/tmp/vaults/Work.conduit');

describe('sync IPC argument validation', () => {
  it('accepts a missing argument object and rejects non-objects', () => {
    expect(argsObject(undefined)).toEqual({});
    expect(argsObject({ a: 1 })).toEqual({ a: 1 });
    expect(() => argsObject('x')).toThrow(InvalidSyncRequest);
    expect(() => argsObject([1])).toThrow(InvalidSyncRequest);
  });

  it('checks booleans and passwords', () => {
    expect(optionalBoolean(undefined, 'x')).toBe(false);
    expect(optionalBoolean(true, 'x')).toBe(true);
    expect(() => optionalBoolean('true', 'x')).toThrow(InvalidSyncRequest);
    expect(requirePassword('pw', 'password')).toBe('pw');
    expect(() => requirePassword('', 'password')).toThrow(InvalidSyncRequest);
    expect(() => requirePassword(42, 'password')).toThrow(InvalidSyncRequest);
  });

  it('accepts only absolute paths without NUL', () => {
    expect(requireFilePath(ABS, 'file')).toBe(ABS);
    expect(() => requireFilePath('relative/Work.conduit', 'file')).toThrow(InvalidSyncRequest);
    expect(() => requireFilePath(`${ABS}\0.txt`, 'file')).toThrow(InvalidSyncRequest);
    expect(() => requireFilePath(123, 'file')).toThrow(InvalidSyncRequest);
  });

  it('creates vaults only at .conduit paths', () => {
    expect(requireVaultTarget(ABS, 'target')).toBe(ABS);
    expect(requireVaultTarget(path.resolve('/tmp/vaults/Work Copy'), 'target')).toBe(path.resolve('/tmp/vaults/Work Copy.conduit'));
    expect(() => requireVaultTarget(path.resolve('/tmp/notes.txt'), 'target')).toThrow('Invalid sync request: the file name must end in .conduit');
    expect(optionalVaultTarget(null, 'target')).toBeNull();
  });

  it('bounds lists', () => {
    expect(requireList([1, 2], 'rows')).toEqual([1, 2]);
    expect(() => requireList({}, 'rows')).toThrow(InvalidSyncRequest);
  });
});
