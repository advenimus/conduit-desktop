import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DailyQuotaManager } from '../daily-quota.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-mcp-quota-'));
  file = path.join(dir, 'mcp-quota.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('DailyQuotaManager', () => {
  it('blocks calls once the quota is used up', () => {
    const quota = new DailyQuotaManager(file);
    quota.record();
    quota.record();

    expect(quota.check(2)).toMatchObject({ allowed: false, count: 2, remaining: 0 });
    expect(quota.check(3)).toMatchObject({ allowed: true, count: 2, remaining: 1 });
  });

  it('never blocks unlimited tiers', () => {
    const quota = new DailyQuotaManager(file);
    quota.record();
    expect(quota.check(-1)).toMatchObject({ allowed: true, remaining: -1 });
  });

  it('drops calls older than 24 hours', () => {
    const old = Date.now() - 25 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify({ calls: [old, Date.now()] }));

    expect(new DailyQuotaManager(file).check(50).count).toBe(1);
  });

  it('sees a ledger reset made by the desktop while this MCP process keeps running', () => {
    const quota = new DailyQuotaManager(file);
    quota.record();
    quota.record();
    quota.record();

    fs.rmSync(file);

    expect(quota.check(3)).toMatchObject({ allowed: true, count: 0 });
    quota.record();
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).calls).toHaveLength(1);
  });

  it('counts calls recorded by other MCP processes sharing the ledger', () => {
    const a = new DailyQuotaManager(file);
    const b = new DailyQuotaManager(file);
    a.record();
    b.record();

    expect(a.check(50).count).toBe(2);
  });
});
