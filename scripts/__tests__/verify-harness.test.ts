// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';

interface RunContext {
  tmpRoot: string;
  runDir: string;
  deviceRoot(name: string): string;
  claimDevice(name: string, owner: string): void;
  onCleanup(label: string, fn: () => void): void;
  runCleanup(): Promise<unknown>;
}

// The harness is plain .mjs without type declarations.
const { parseArgs } = (await import('../verify/run.mjs' as string)) as {
  parseArgs(argv: string[]): { suites: string[]; only: string[]; keep: boolean; help: boolean };
};
const { redact } = (await import('../verify/lib/redact.mjs' as string)) as { redact(text: string): string };
const { createRunContext, freePort } = (await import('../verify/lib/run-context.mjs' as string)) as {
  createRunContext(opts?: { keep?: boolean }): RunContext;
  freePort(): Promise<number>;
};

describe('verify run.mjs parseArgs', () => {
  it('defaults to every suite', () => {
    expect(parseArgs([])).toEqual({ suites: ['all'], only: [], keep: false, help: false });
  });

  it('reads suites, repeated --only and --keep', () => {
    expect(parseArgs(['sync', 'mcp', '--only', 'a', '--only', 'b', '--keep'])).toEqual({
      suites: ['sync', 'mcp'], only: ['a', 'b'], keep: true, help: false,
    });
  });

  it('rejects unknown options and a bare --only', () => {
    expect(() => parseArgs(['--fast'])).toThrow('Unknown option --fast');
    expect(() => parseArgs(['--only'])).toThrow('--only needs a scenario id');
    expect(() => parseArgs(['--only', '--keep'])).toThrow('--only needs a scenario id');
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
