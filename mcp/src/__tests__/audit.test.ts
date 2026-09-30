// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLogger, auditEnv } from '../audit.js';

let dir: string;
let logPath: string;
const savedEnv = process.env.CONDUIT_ENV;

function readLines(): Array<Record<string, unknown>> {
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-mcp-audit-'));
  logPath = path.join(dir, 'audit.log');
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CONDUIT_ENV;
  else process.env.CONDUIT_ENV = savedEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('auditEnv', () => {
  it('is preview only when CONDUIT_ENV is preview', () => {
    process.env.CONDUIT_ENV = 'preview';
    expect(auditEnv()).toBe('preview');
    process.env.CONDUIT_ENV = 'production';
    expect(auditEnv()).toBe('production');
    delete process.env.CONDUIT_ENV;
    expect(auditEnv()).toBe('production');
    process.env.CONDUIT_ENV = 'staging';
    expect(auditEnv()).toBe('production');
  });
});

describe('AuditLogger lines', () => {
  it('carry env on every result type, beside the unchanged fields', () => {
    process.env.CONDUIT_ENV = 'preview';
    const logger = AuditLogger.create(logPath);
    logger.logSuccess('entry_search', 'mcp-client', { query: 'q' }, 12);
    logger.logError('terminal_execute', 'mcp-client', { session_id: 's1' }, 'Vault is locked', 3);
    logger.logRateLimited('entry_list', 'mcp-client', {});
    logger.logAccessDenied('credential_read', 'mcp-client', { id: 'c1' }, 1);
    logger.close();

    const lines = readLines();
    expect(lines).toHaveLength(4);
    for (const l of lines) {
      expect(l.env).toBe('preview');
      expect(Object.keys(l).sort()).toEqual(['client', 'duration_ms', 'env', 'parameters', 'result', 'timestamp', 'tool']);
    }
    expect(lines.map((l) => (l.result as { type: string }).type)).toEqual(['success', 'error', 'rate_limited', 'access_denied']);
    expect(lines[1].result).toEqual({ type: 'error', message: 'Vault is locked' });
  });

  it('writes production outside preview and keeps redaction', () => {
    delete process.env.CONDUIT_ENV;
    const logger = AuditLogger.create(logPath);
    logger.logSuccess('credential_create', 'mcp-client', { name: 'n', password: 'hunter2', nested: { api_key: 'k' } }, 5);
    logger.close();
    const [line] = readLines();
    expect(line.env).toBe('production');
    expect(line.parameters).toEqual({ name: 'n', password: '[REDACTED]', nested: { api_key: '[REDACTED]' } });
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('hunter2');
  });
});
