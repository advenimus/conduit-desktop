// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

interface RunContext {
  tmpRoot: string;
  runDir: string;
  deviceRoot(name: string): string;
  claimDevice(name: string, owner: string): void;
  onCleanup(label: string, fn: () => void): void;
  runCleanup(): Promise<unknown>;
}

interface Scenario { id: string; title: string; needsSupabase?: boolean; run(): void }
interface Suite { id: string; title: string; optIn?: boolean; scenarios: Scenario[] }
interface Opts { suites: string[]; only: string[]; keep: boolean; strict: boolean; before: string | null; help: boolean }

// The harness is plain .mjs without type declarations.
const runner = (await import('../verify/run.mjs' as string)) as {
  parseArgs(argv: string[]): Opts;
  selectSuites(available: Suite[], opts: Opts): Suite[];
  needsSupabase(suites: Suite[]): boolean;
  usage(suites: Suite[]): string;
  loadSuites(dir?: string): Promise<Suite[]>;
};
const { parseArgs } = runner;
const { scenarioContext } = (await import('../verify/lib/context.mjs' as string)) as {
  scenarioContext(arg: { run: unknown; env: unknown; step: (m: string) => void; options?: { strict?: boolean; before?: string } }): { ctx: { options: { strict: boolean; before: string | null } } };
};
const { redact } = (await import('../verify/lib/redact.mjs' as string)) as { redact(text: string): string };
const { createRunContext, freePort } = (await import('../verify/lib/run-context.mjs' as string)) as {
  createRunContext(opts?: { keep?: boolean }): RunContext;
  freePort(): Promise<number>;
};

describe('verify run.mjs parseArgs', () => {
  it('defaults to every suite', () => {
    expect(parseArgs([])).toEqual({ suites: ['all'], only: [], keep: false, strict: false, before: null, help: false });
  });

  it('reads suites, repeated --only, --keep, --strict and --before', () => {
    expect(parseArgs(['sync', 'mcp', '--only', 'a', '--only', 'b', '--keep', '--strict', '--before', '/ref dir'])).toEqual({
      suites: ['sync', 'mcp'], only: ['a', 'b'], keep: true, strict: true, before: '/ref dir', help: false,
    });
  });

  it('rejects unknown options and a bare --only', () => {
    expect(() => parseArgs(['--fast'])).toThrow('Unknown option --fast');
    expect(() => parseArgs(['--only'])).toThrow('--only needs a scenario id');
    expect(() => parseArgs(['--only', '--keep'])).toThrow('--only needs a scenario id');
    expect(() => parseArgs(['--before'])).toThrow('--before needs a folder');
  });
});

const scenario = (id: string, needsSupabase?: boolean): Scenario => ({ id, title: id, run() {}, ...(needsSupabase === undefined ? {} : { needsSupabase }) });
const SUITES: Suite[] = [
  { id: 'mcp', title: 'MCP', scenarios: [scenario('m1')] },
  { id: 'restyle', title: 'Layout reference', optIn: true, scenarios: [scenario('screens', false), scenario('sidebar-signed-in', true)] },
  { id: 'smoke', title: 'Smoke', scenarios: [scenario('two-devices'), scenario('ipc-and-mcp')] },
];
const opts = (argv: string[]) => parseArgs(argv);
const ids = (suites: Suite[]) => suites.map((s) => `${s.id}(${s.scenarios.map((sc) => sc.id).join(',')})`);

describe('verify run.mjs suite selection', () => {
  it('skips opt-in suites in all', () => {
    expect(ids(runner.selectSuites(SUITES, opts([])))).toEqual(['mcp(m1)', 'smoke(two-devices,ipc-and-mcp)']);
  });

  it('runs an opt-in suite when it is named, alone or next to all', () => {
    expect(ids(runner.selectSuites(SUITES, opts(['restyle'])))).toEqual(['restyle(screens,sidebar-signed-in)']);
    expect(ids(runner.selectSuites(SUITES, opts(['all', 'restyle'])))).toHaveLength(3);
  });

  it('runs only the named suites and scenarios', () => {
    expect(ids(runner.selectSuites(SUITES, opts(['smoke'])))).toEqual(['smoke(two-devices,ipc-and-mcp)']);
    expect(ids(runner.selectSuites(SUITES, opts(['restyle', '--only', 'screens'])))).toEqual(['restyle(screens)']);
    expect(() => runner.selectSuites(SUITES, opts(['nope']))).toThrow('No suite named nope');
  });

  it('starts Supabase only when a selected scenario needs it', () => {
    expect(runner.needsSupabase(runner.selectSuites(SUITES, opts(['restyle', '--only', 'screens'])))).toBe(false);
    expect(runner.needsSupabase(runner.selectSuites(SUITES, opts(['restyle'])))).toBe(true);
    expect(runner.needsSupabase(runner.selectSuites(SUITES, opts(['smoke'])))).toBe(true);
  });

  it('lists the opt-in suites and --strict in --help', () => {
    const help = runner.usage(SUITES);
    expect(help).toContain('--strict');
    expect(help).toContain('--before <dir>');
    expect(help).toMatch(/Opt-in suites[^\n]*\n\s+restyle\s+Layout reference/);
    expect(help).not.toMatch(/^\s+smoke\s/m);
  });

  it('loads the real suites: restyle is opt-in and all leaves it out', async () => {
    const real = await runner.loadSuites();
    expect(real.find((s) => s.id === 'restyle')?.optIn).toBe(true);
    expect(runner.selectSuites(real, opts([])).map((s) => s.id)).not.toContain('restyle');
    const restyle = runner.selectSuites(real, opts(['restyle']))[0];
    expect(restyle.scenarios.filter((sc) => sc.needsSupabase).map((sc) => sc.id)).toEqual(['sidebar-signed-in']);
    expect(restyle.scenarios.every((sc) => typeof sc.needsSupabase === 'boolean')).toBe(true);
  });

  it('hands --strict and --before to the scenario context', () => {
    const step = () => {};
    expect(scenarioContext({ run: {}, env: {}, step, options: { strict: true, before: '/r' } }).ctx.options).toEqual({ strict: true, before: '/r' });
    expect(scenarioContext({ run: {}, env: {}, step }).ctx.options).toEqual({ strict: false, before: null });
  });
});

const { writeLauncher } = (await import('../verify/lib/launcher.mjs' as string)) as { writeLauncher(root: string, opts: { version: string }): string };

describe('verify launcher', () => {
  it('writes a main module that parses, keeps popups only on request and records shortcuts and views', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher '));
    try {
      const main = path.join(writeLauncher(root, { version: '1.0.0' }), 'main.mjs');
      const check = spawnSync(process.execPath, ['--check', main], { encoding: 'utf8' });
      expect(check.stderr).toBe('');
      expect(check.status).toBe(0);
      const src = fs.readFileSync(main, 'utf8');
      expect(src).toContain("process.env.CV_KEEP_POPUPS === '1'");
      expect(src).toContain("url.includes('/picker.html')");
      expect(src).toContain('globalThis.__cvShortcut');
      expect(src).toContain('globalThis.__cvAttachedWebViews');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('verify redact', () => {
  it('masks JWTs, named tokens and Supabase keys', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJlLXZhbHVl';
    const out = redact(`conduit://auth/callback#access_token=${jwt}&refresh_token=abcdefgh1234 sb_secret_0123456789abcdef`);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('abcdefgh1234');
    expect(out).not.toContain('sb_secret_0123456789abcdef');
  });

  it('keeps short flag values readable', () => {
    expect(redact('has access_token: true')).toBe('has access_token: true');
  });
});

describe('verify run context', () => {
  it('finds a port nothing is listening on', async () => {
    const port = await freePort();
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer().once('error', reject).listen(port, '127.0.0.1', () => server.close(() => resolve()));
    });
    expect(port).not.toBe(1420);
  });

  it('validates device names and runs cleanup newest first, once', async () => {
    const run = createRunContext();
    try {
      expect(() => run.deviceRoot('Bad Name')).toThrow('Device name');
      expect(run.deviceRoot('a1')).toBe(`${run.tmpRoot}/a1`);
      const order: string[] = [];
      run.onCleanup('first', () => { order.push('first'); });
      run.onCleanup('second', () => { order.push('second'); });
      await run.runCleanup();
      await run.runCleanup();
      expect(order).toEqual(['second', 'first']);
      expect(fs.existsSync(run.tmpRoot)).toBe(false);
    } finally {
      fs.rmSync(run.runDir, { recursive: true, force: true });
      fs.rmSync(run.tmpRoot, { recursive: true, force: true });
    }
  });

  it('refuses a device name another scenario of the run already used', () => {
    const run = createRunContext();
    try {
      run.claimDevice('c1', 'backup/cloud-backup-plan-gate');
      expect(() => run.claimDevice('c1', 'backup/cloud-backup-plan-gate')).not.toThrow();
      expect(() => run.claimDevice('c1', 'copies/provider-conflict-copy')).toThrow('already used by backup/cloud-backup-plan-gate');
      expect(() => run.claimDevice('c2', 'copies/provider-conflict-copy')).not.toThrow();
    } finally {
      fs.rmSync(run.runDir, { recursive: true, force: true });
      fs.rmSync(run.tmpRoot, { recursive: true, force: true });
    }
  });
});

const { colorSchemeOption } = (await import('../verify/lib/app.mjs' as string)) as {
  colorSchemeOption(opts: Record<string, unknown>): { colorScheme?: string | null };
};

describe('the emulated system mode of a device', () => {
  it("leaves Playwright's default light when no colorScheme is asked for", () => {
    expect(colorSchemeOption({})).toEqual({});
  });

  it('passes a mode, or null for the machine mode, to electron.launch', () => {
    expect(colorSchemeOption({ colorScheme: 'dark' })).toEqual({ colorScheme: 'dark' });
    expect(colorSchemeOption({ colorScheme: 'light' })).toEqual({ colorScheme: 'light' });
    expect(colorSchemeOption({ colorScheme: null })).toEqual({ colorScheme: null });
  });

  it('rejects anything else', () => {
    expect(() => colorSchemeOption({ colorScheme: 'sepia' })).toThrow('colorScheme must be one of');
    expect(() => colorSchemeOption({ colorScheme: undefined })).toThrow('colorScheme must be one of');
  });
});
