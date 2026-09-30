/** Test doubles for the sync IPC registrars (no Electron, no AppState). */

import { vi } from 'vitest';

export class FakeIpc {
  readonly handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();

  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate channel ${channel}`);
    this.handlers.set(channel, listener);
  }

  async invoke(channel: string, raw?: unknown): Promise<unknown> {
    const fn = this.handlers.get(channel);
    if (fn === undefined) throw new Error(`no handler for ${channel}`);
    return fn(null, raw);
  }
}

export interface FakeCopy {
  readonly path: string;
}

export function fakeEngineVault(opts: { copies?: readonly FakeCopy[]; ownEpoch?: string } = {}) {
  const copies = opts.copies ?? [];
  const engine = {
    reviewSideFileWal: vi.fn(async () => 'candidate-1'),
    parts: () => ({
      scanner: { last: () => ({ copies }) },
      status: { snapshot: () => ({ prompts: [], otherCopies: [] }) },
    }),
  };
  const replica = { ring: () => ({ current: { epochId: opts.ownEpoch ?? 'epoch-own' } }) };
  return { engine, replica };
}

export function silenceConsole(): void {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
}
