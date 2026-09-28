// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { signOutReleasingVault } from '../sign-out-flow.js';

describe('signOutReleasingVault', () => {
  it('releases the vault lease before Supabase signs out', async () => {
    const order: string[] = [];
    await signOutReleasingVault({
      releaseVault: async () => {
        order.push('release');
      },
      signOut: async () => {
        order.push('sign-out');
      },
    });
    expect(order).toEqual(['release', 'sign-out']);
  });

  it('waits for a slow release before signing out', async () => {
    let finishRelease: () => void = () => undefined;
    const signOut = vi.fn(async () => undefined);
    const done = signOutReleasingVault({
      releaseVault: () => new Promise<void>((resolve) => (finishRelease = resolve)),
      signOut,
    });
    await Promise.resolve();
    expect(signOut).not.toHaveBeenCalled();
    finishRelease();
    await done;
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('still signs out when the release fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const signOut = vi.fn(async () => undefined);
    await signOutReleasingVault({ releaseVault: () => Promise.reject(new Error('offline')), signOut });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('passes a sign-out failure on to the caller', async () => {
    await expect(
      signOutReleasingVault({ releaseVault: async () => undefined, signOut: () => Promise.reject(new Error('no network')) }),
    ).rejects.toThrow('no network');
  });
});
