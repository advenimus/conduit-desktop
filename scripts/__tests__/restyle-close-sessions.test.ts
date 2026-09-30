// @vitest-environment node
import { describe, expect, it } from 'vitest';

interface Sess { id: string }
const data = (await import('../verify/lib/restyle-data.mjs' as string)) as {
  HOME_SESSION_ID: string;
  closeAllSessions(device: unknown): Promise<void>;
  clearConnectionHistory(device: unknown): Promise<unknown>;
};

/** A device whose page runs withStores sources against fake stores instead of the app's modules. */
function fakeDevice(initial: Sess[], { closes = true } = {}) {
  let sessions = [...initial];
  const closed: string[] = [];
  const session = {
    getState: () => ({
      sessions,
      closeSession: async (id: string) => {
        closed.push(id);
        if (closes && id !== data.HOME_SESSION_ID) sessions = sessions.filter((s) => s.id !== id);
      },
    }),
  };
  const stubs: Record<string, unknown> = { sessionStore: { useSessionStore: session } };
  const page = {
    evaluate: async (source: string) => {
      const runnable = source.replace(/import\('\/src\/stores\/(\w+)\.ts'\)/g, (_m, name: string) => `__stub(${JSON.stringify(name)})`);
      const run = new Function('__stub', `return ${runnable};`) as (stub: (n: string) => unknown) => Promise<unknown>;
      return run(async (name) => stubs[name] ?? {});
    },
  };
  return { device: { name: 'fake', page }, closed, sessions: () => sessions };
}

describe('restyle closeAllSessions', () => {
  it('closes every tab but the pinned Home tab and is done when only Home is left', async () => {
    const home = { id: data.HOME_SESSION_ID };
    const fake = fakeDevice([home, { id: 't1' }, { id: 'w1' }]);
    await data.closeAllSessions(fake.device);
    expect(fake.closed).toEqual(['t1', 'w1']);
    expect(fake.sessions()).toEqual([home]);
  });

  it('is done at once with no sessions (a locked vault)', async () => {
    const fake = fakeDevice([]);
    await expect(data.closeAllSessions(fake.device)).resolves.toBeUndefined();
  });
});

describe('restyle clearConnectionHistory', () => {
  it('clears through dashboardApi and bumps the Home history version, like Customize', async () => {
    const calls: string[] = [];
    const modules: Record<string, unknown> = {
      '/src/lib/dashboardApi.ts': { dashboardApi: { historyClear: async () => calls.push('clear') } },
      '/src/components/dashboard/home/homeFeeds.ts': { bumpHistoryVersion: () => calls.push('bump') },
    };
    const page = {
      evaluate: async (source: string) => {
        const runnable = source.replace(/import\('([^']+)'\)/g, (_m, spec: string) => `__load(${JSON.stringify(spec)})`);
        return (new Function('__load', `return ${runnable};`) as (load: (s: string) => Promise<unknown>) => Promise<unknown>)(async (spec) => modules[spec]);
      },
    };
    await expect(data.clearConnectionHistory({ name: 'fake', page })).resolves.toBe(true);
    expect(calls).toEqual(['clear', 'bump']);
  });
});
