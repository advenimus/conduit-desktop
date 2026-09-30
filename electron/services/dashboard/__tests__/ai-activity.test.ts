// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLogPath, parseAuditLine, readAiActivity } from '../ai-activity.js';

let dir: string;
let logPath: string;

function line(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: '2026-09-29T10:00:00.000Z',
    tool: 'terminal_execute',
    client: 'mcp-client',
    parameters: { session_id: 'sess-1', command: 'ls /secret-host' },
    result: { type: 'success' },
    duration_ms: 42,
    env: 'production',
    ...overrides,
  });
}

function write(lines: string[]): void {
  fs.writeFileSync(logPath, `${lines.join('\n')}\n`);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-audit-'));
  logPath = path.join(dir, 'audit.log');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('auditLogPath', () => {
  it('matches the MCP default path', () => {
    expect(auditLogPath('/home/u')).toBe(path.join('/home/u', '.config', 'conduit', 'audit.log'));
  });
});

describe('parseAuditLine', () => {
  it('keeps only the tool, outcome, time, duration and id-shaped ids', () => {
    expect(parseAuditLine(line(), 'production')).toEqual({
      at: '2026-09-29T10:00:00.000Z',
      tool: 'terminal_execute',
      outcome: 'success',
      durationMs: 42,
      entryId: null,
      sessionId: 'sess-1',
    });
  });

  it('reads entry_id, or id for entry, credential and document tools only', () => {
    expect(parseAuditLine(line({ tool: 'connection_open_entry', parameters: { entry_id: 'e-1' } }), 'production')?.entryId).toBe('e-1');
    expect(parseAuditLine(line({ tool: 'entry_info', parameters: { id: 'e-2' } }), 'production')?.entryId).toBe('e-2');
    expect(parseAuditLine(line({ tool: 'credential_read', parameters: { id: 'c-1' } }), 'production')?.entryId).toBe('c-1');
    expect(parseAuditLine(line({ tool: 'document_read', parameters: { id: 'd-1' } }), 'production')?.entryId).toBe('d-1');
    expect(parseAuditLine(line({ tool: 'website_close_tab', parameters: { id: 'tab-1' } }), 'production')?.entryId).toBeNull();
  });

  it('drops ids that do not look like ids', () => {
    const item = parseAuditLine(line({ parameters: { entry_id: 'web01.example.com', session_id: 'a b' } }), 'production');
    expect(item?.entryId).toBeNull();
    expect(item?.sessionId).toBeNull();
    expect(parseAuditLine(line({ parameters: { entry_id: 'x'.repeat(65) } }), 'production')?.entryId).toBeNull();
  });

  it('never passes error text through', () => {
    const item = parseAuditLine(line({ result: { type: 'error', message: 'host web01 refused' } }), 'production');
    expect(item?.outcome).toBe('error');
    expect(JSON.stringify(item)).not.toContain('web01');
  });

  it('skips bad lines', () => {
    const bad = [
      'not json',
      '[1,2]',
      '"text"',
      line({ timestamp: 5 }),
      line({ timestamp: 'yesterday' }),
      line({ tool: 'Terminal-Execute' }),
      line({ tool: 'x'.repeat(65) }),
      line({ result: { type: 'weird' } }),
      line({ result: 'success' }),
    ];
    for (const l of bad) expect(parseAuditLine(l, 'production')).toBeNull();
  });

  it('uses 0 when duration_ms is missing or not a number', () => {
    expect(parseAuditLine(line({ duration_ms: undefined }), 'production')?.durationMs).toBe(0);
    expect(parseAuditLine(line({ duration_ms: 'slow' }), 'production')?.durationMs).toBe(0);
  });

  it('keeps only lines of this environment; legacy lines count as production', () => {
    const legacy = line({ env: undefined });
    const preview = line({ env: 'preview' });
    const prod = line({ env: 'production' });
    expect(parseAuditLine(legacy, 'production')).not.toBeNull();
    expect(parseAuditLine(legacy, 'preview')).toBeNull();
    expect(parseAuditLine(preview, 'preview')).not.toBeNull();
    expect(parseAuditLine(preview, 'production')).toBeNull();
    expect(parseAuditLine(prod, 'preview')).toBeNull();
    expect(parseAuditLine(line({ env: 7 }), 'production')).toBeNull();
  });
});

describe('readAiActivity', () => {
  it('reports a missing log', async () => {
    await expect(readAiActivity({ logPath, environment: 'production', limit: 5 })).resolves.toEqual({ items: [], logFound: false });
  });

  it('returns newest first, limited', async () => {
    write([
      line({ timestamp: '2026-09-29T10:00:00.000Z', tool: 'a_one' }),
      line({ timestamp: '2026-09-29T10:02:00.000Z', tool: 'c_three' }),
      line({ timestamp: '2026-09-29T10:01:00.000Z', tool: 'b_two' }),
      '',
    ]);
    const res = await readAiActivity({ logPath, environment: 'production', limit: 2 });
    expect(res.logFound).toBe(true);
    expect(res.items.map((i) => i.tool)).toEqual(['c_three', 'b_two']);
  });

  it('reads only the tail and drops the partial first line', async () => {
    const first = line({ tool: 'first_line' });
    const second = line({ tool: 'second_line' });
    write([first, second]);
    const tailBytes = second.length + 1 + 10;
    const res = await readAiActivity({ logPath, environment: 'production', limit: 10, tailBytes });
    expect(res.items.map((i) => i.tool)).toEqual(['second_line']);
  });

  it('keeps the first line when the tail covers the whole file', async () => {
    write([line({ tool: 'only_line' })]);
    const res = await readAiActivity({ logPath, environment: 'production', limit: 10, tailBytes: 1024 * 1024 });
    expect(res.items.map((i) => i.tool)).toEqual(['only_line']);
  });

  it('gives an empty list for a tail with no complete line', async () => {
    write([line({ tool: 'long_line' })]);
    const res = await readAiActivity({ logPath, environment: 'production', limit: 10, tailBytes: 20 });
    expect(res).toEqual({ items: [], logFound: true });
  });

  it('turns a read error into logFound false with a warning', async () => {
    fs.mkdirSync(logPath);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(readAiActivity({ logPath, environment: 'production', limit: 5 })).resolves.toEqual({ items: [], logFound: false });
    expect(warn).toHaveBeenCalled();
  });
});
