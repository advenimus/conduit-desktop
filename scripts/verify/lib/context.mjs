// The `ctx` object every scenario's run(ctx) receives.

import { isDeepStrictEqual } from 'node:util';
import { isLive, killDevice, launchDevice, quitDevice } from './app.mjs';
import * as flows from './flows.mjs';
import { connectMcp } from './mcp.mjs';
import { startNetProxy } from './net-proxy.mjs';
import { createTestUser, leaseRows, setTier, sql, sqlJson } from './supabase.mjs';
import { createTeam } from './team.mjs';
import * as ui from './ui.mjs';

export class CheckError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CheckError';
  }
}

const SUPABASE_PORT = 54321;

/**
 * Devices and MCP clients opened through ctx are closed when the scenario ends (devices quit
 * normally, so leases are released), pass or fail. onClose hooks run after that, newest first.
 * `options` are the run's command-line options for suites ({strict, before}).
 */
export function scenarioContext({ run, env, step, scenario = null, options = {} }) {
  const devices = [];
  const mcpClients = [];
  const closers = [];

  function onClose(label, fn) {
    closers.push({ label, fn });
  }

  const ctx = {
    run,
    options: Object.freeze({ strict: options.strict === true, before: options.before ?? null }),
    runId: run.runId,
    cloudDir: run.cloudDir,
    step,
    ui,
    flows,
    sleep: ui.sleep,
    waitFor: ui.waitFor,

    async launchDevice(name, opts) {
      if (scenario !== null) run.claimDevice?.(name, scenario);
      const device = await launchDevice(run, env, name, opts);
      devices.push(device);
      step(`launched device ${name} (pid ${device.pid})`);
      return device;
    },
    quitDevice,
    killDevice,
    liveDevices: () => devices.filter(isLive),

    createUser: (role = 'free') => createTestUser(run, role),
    createTeam: (owner, opts) => createTeam(run, owner, opts),
    onClose,

    /**
     * A TCP proxy to the local Supabase for one device: launchDevice(name, {env: proxy.env}), then
     * proxy.cut() / proxy.restore(). Closed when the scenario ends (after its devices quit).
     */
    async supabaseProxy() {
      const proxy = await startNetProxy(SUPABASE_PORT);
      const stopAtRunEnd = run.onCleanup(`close Supabase proxy :${proxy.port}`, () => proxy.close());
      onClose(`Supabase proxy :${proxy.port}`, stopAtRunEnd);
      step(`Supabase proxy on ${proxy.url}`);
      return proxy;
    },
    setTier,
    sql,
    sqlJson,
    leaseRows,

    async connectMcp(device) {
      const client = await connectMcp(device);
      mcpClients.push(client);
      return client;
    },

    async shot(device, label) {
      const file = await ui.screenshot(device, label);
      step(`screenshot ${file.slice(run.runDir.length + 1)}`);
      return file;
    },

    check(condition, message) {
      if (!condition) throw new CheckError(`Check failed: ${message}`);
    },
    checkEqual(actual, expected, message) {
      if (!isDeepStrictEqual(actual, expected)) {
        throw new CheckError(`Check failed: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
      }
    },
  };

  async function close() {
    for (const client of mcpClients.splice(0)) await client.close().catch(() => {});
    const results = await Promise.all(devices.splice(0).filter(isLive).map(async (d) => `${d.name}: ${await quitDevice(d)}`));
    if (results.length > 0) step(`closed devices (${results.join(', ')})`);
    for (const { label, fn } of closers.splice(0).reverse()) {
      try {
        await fn();
      } catch (err) {
        step(`close hook "${label}" failed: ${err.message}`);
      }
    }
  }

  return { ctx, close };
}
