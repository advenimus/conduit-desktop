// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { silenceConsole } from './sync-fakes.js';
import {
  ATTEMPT_LIFETIME_MS,
  StartupAttempt,
  decidePlan,
  parseStartupVault,
  withStartupCleared,
  withStartupPathMoved,
  type PlanInput,
} from '../startup-vault-core.js';

const personal = { kind: 'personal' as const, path: '/v/Work.conduit', lineageId: 'L1' };

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    skipRequested: false,
    startupVault: personal,
    lastVaultType: null,
    fileExists: true,
    lineageMatches: true,
    launchHasUrl: false,
    entryExists: true,
    storeUsable: true,
    ...over,
  };
}

beforeEach(() => silenceConsole());

describe('parseStartupVault (spec 3.5)', () => {
  it('accepts the three kinds', () => {
    expect(parseStartupVault({ kind: 'hub' })).toEqual({ kind: 'hub' });
    expect(parseStartupVault(personal)).toEqual(personal);
    expect(parseStartupVault({ kind: 'personal', path: '/v/A.conduit' })).toEqual({ kind: 'personal', path: '/v/A.conduit', lineageId: null });
    expect(parseStartupVault({ kind: 'team', teamVaultId: 't1' })).toEqual({ kind: 'team', teamVaultId: 't1' });
    expect(parseStartupVault(null)).toBeNull();
  });

  it('reads an unknown kind, a relative path or an empty id as null', () => {
    expect(parseStartupVault({ kind: 'cloud' })).toBeNull();
    expect(parseStartupVault({ kind: 'personal', path: 'rel/A.conduit' })).toBeNull();
    expect(parseStartupVault({ kind: 'team', teamVaultId: '' })).toBeNull();
    expect(parseStartupVault('hub')).toBeNull();
  });
});

describe('settings helpers are pure', () => {
  it('withStartupPathMoved follows a rename and leaves the input alone', () => {
    const s = { startup_vault: personal };
    const moved = withStartupPathMoved(s, '/v/Work.conduit', '/v/Job.conduit');
    expect(moved.startup_vault).toEqual({ ...personal, path: '/v/Job.conduit' });
    expect(s.startup_vault.path).toBe('/v/Work.conduit');
    expect(withStartupPathMoved(s, '/v/Other.conduit', '/x')).toBe(s);
  });

  it('withStartupCleared resets a matching personal vault to the hub', () => {
    const s = { startup_vault: personal };
    expect(withStartupCleared(s, '/v/Work.conduit').startup_vault).toEqual({ kind: 'hub' });
    expect(withStartupCleared(s, null).startup_vault).toEqual({ kind: 'hub' });
    expect(withStartupCleared(s, '/v/Other.conduit')).toBe(s);
    const team = { startup_vault: { kind: 'team' as const, teamVaultId: 't' } };
    expect(withStartupCleared(team, null)).toBe(team);
  });
});

describe('decidePlan (spec 4.2 b to f)', () => {
  it('escape hatch goes to the hub and names the skipped vault', () => {
    expect(decidePlan(input({ skipRequested: true }))).toEqual({ kind: 'hub', skipped: { name: 'Work' } });
    expect(decidePlan(input({ skipRequested: true, startupVault: { kind: 'team', teamVaultId: 't' } }))).toEqual({ kind: 'hub', skipped: { name: null } });
    expect(decidePlan(input({ skipRequested: true, startupVault: null, lastVaultType: 'team' }))).toEqual({ kind: 'hub', skipped: { name: null } });
    expect(decidePlan(input({ skipRequested: true, startupVault: { kind: 'hub' } }))).toEqual({ kind: 'hub' });
  });

  it('null keeps the team rule, hub and team map through', () => {
    expect(decidePlan(input({ startupVault: null }))).toEqual({ kind: 'automatic' });
    expect(decidePlan(input({ startupVault: { kind: 'hub' } }))).toEqual({ kind: 'hub' });
    expect(decidePlan(input({ startupVault: { kind: 'team', teamVaultId: 't9' } }))).toEqual({ kind: 'team', teamVaultId: 't9' });
  });

  it('personal: missing file, lineage mismatch, deep-link launch, no entry, weak store', () => {
    expect(decidePlan(input({ fileExists: false }))).toEqual({ kind: 'hub', missing: { fileName: 'Work.conduit', path: '/v/Work.conduit' } });
    expect(decidePlan(input())).toEqual({ kind: 'personal', path: '/v/Work.conduit', name: 'Work', auto: true });
    for (const over of [{ lineageMatches: false }, { launchHasUrl: true }, { entryExists: false }, { storeUsable: false }]) {
      expect(decidePlan(input(over))).toMatchObject({ kind: 'personal', auto: false });
    }
  });
});

describe('StartupAttempt (spec 4.3, 4.6)', () => {
  let t = 0;
  const now = () => t;
  beforeEach(() => {
    t = 0;
  });

  it('is a one-shot: the second plan gets nothing', () => {
    const a = new StartupAttempt(now);
    expect(a.consume()).toBe(true);
    expect(a.consume()).toBe(false);
  });

  it('first try, then retries only while open; the password drops at done', () => {
    const a = new StartupAttempt(now);
    expect(a.attemptKind()).toBeNull();
    a.consume();
    expect(a.attemptKind()).toBe('first');
    a.holdPassword('pw');
    a.markFailed();
    expect(a.attemptKind()).toBe('retry');
    expect(a.savedPassword()).toBe('pw');
    a.finish();
    expect(a.attemptKind()).toBeNull();
    expect(a.savedPassword()).toBeNull();
  });

  it('ends after 10 minutes', () => {
    const a = new StartupAttempt(now);
    a.consume();
    a.holdPassword('pw');
    a.markFailed();
    t = ATTEMPT_LIFETIME_MS + 1;
    expect(a.attemptKind()).toBeNull();
    expect(a.savedPassword()).toBeNull();
  });

  it('success, a lock, or another unlock ends it', () => {
    for (const end of [(a: StartupAttempt) => a.succeeded(), (a: StartupAttempt) => a.locked(false, true), (a: StartupAttempt) => a.userUnlocked()]) {
      const a = new StartupAttempt(now);
      a.consume();
      a.markFailed();
      end(a);
      expect(a.attemptKind()).toBeNull();
    }
  });

  it('re-arms only when the close lock closed a vault that opened automatically with no lock since', () => {
    const a = new StartupAttempt(now);
    a.consume();
    a.succeeded();
    a.locked(true, true);
    expect(a.shown()).toBe(true);
    expect(a.consume()).toBe(true);
    expect(a.shown()).toBe(false);
  });

  it('Lock, then close, then show does not re-arm', () => {
    const a = new StartupAttempt(now);
    a.consume();
    a.succeeded();
    a.locked(false, true);
    a.locked(true, false);
    expect(a.shown()).toBe(false);
  });

  it('a second launch with a link or file cancels the re-arm', () => {
    const a = new StartupAttempt(now);
    a.consume();
    a.succeeded();
    a.locked(true, true);
    a.cancelRearm();
    expect(a.shown()).toBe(false);
  });

  it('a vault unlocked by a person never re-arms on close', () => {
    const a = new StartupAttempt(now);
    a.consume();
    a.userUnlocked();
    a.locked(true, true);
    expect(a.shown()).toBe(false);
  });
});
