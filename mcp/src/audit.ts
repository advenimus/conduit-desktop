/**
 * Audit logging for MCP tool invocations.
 *
 * Port of crates/conduit-mcp/src/audit.rs
 *
 * Writes JSON lines to ~/.config/conduit/audit.log with sensitive field redaction.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

type AuditResult =
  | { type: 'success' }
  | { type: 'error'; message: string }
  | { type: 'rate_limited' }
  | { type: 'access_denied' };

interface AuditEntry {
  timestamp: string;
  tool: string;
  client: string;
  parameters: unknown;
  result: AuditResult;
  duration_ms: number;
}

const SENSITIVE_FIELDS = ['password', 'private_key', 'secret', 'token', 'key'];

function redactSensitive(params: unknown): unknown {
  if (params === null || params === undefined) {
    return params;
  }

  if (Array.isArray(params)) {
    return params.map(redactSensitive);
  }

  if (typeof params === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_FIELDS.some((f) => lowerKey.includes(f))) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactSensitive(value);
      }
    }
    return result;
  }

  return params;
}

function defaultAuditLogPath(): string {
  const home = os.homedir();
  return path.join(home, '.config', 'conduit', 'audit.log');
}

export class AuditLogger {
  private fd: number | null;
  private filePath: string;

  private constructor(fd: number | null, filePath: string) {
    this.fd = fd;
    this.filePath = filePath;
  }

  static create(filePath?: string): AuditLogger {
    const logPath = filePath ?? defaultAuditLogPath();
    try {
      const dir = path.dirname(logPath);
      fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(logPath, 'a');
      return new AuditLogger(fd, logPath);
    } catch {
      return AuditLogger.noop();
    }
  }

  static noop(): AuditLogger {
    return new AuditLogger(null, '');
  }

  private log(entry: AuditEntry): void {
    if (this.fd === null) return;

    const redacted: AuditEntry = {
      ...entry,
      parameters: redactSensitive(entry.parameters),
    };

    try {
      const line = JSON.stringify(redacted) + '\n';
      fs.writeSync(this.fd, line);
    } catch {
      // Silently ignore write errors
    }
  }

  logSuccess(tool: string, client: string, parameters: unknown, durationMs: number): void {
    this.log({
      timestamp: new Date().toISOString(),
      tool,
      client,
      parameters,
      result: { type: 'success' },
      duration_ms: durationMs,
    });
  }

  logError(
    tool: string,
    client: string,
    parameters: unknown,
    error: string,
    durationMs: number,
  ): void {
    this.log({
      timestamp: new Date().toISOString(),
      tool,
      client,
      parameters,
      result: { type: 'error', message: error },
      duration_ms: durationMs,
    });
  }

  logRateLimited(tool: string, client: string, parameters: unknown): void {
    this.log({
      timestamp: new Date().toISOString(),
      tool,
      client,
      parameters,
      result: { type: 'rate_limited' },
      duration_ms: 0,
    });
  }

  logAccessDenied(tool: string, client: string, parameters: unknown, durationMs: number): void {
    this.log({
      timestamp: new Date().toISOString(),
      tool,
      client,
      parameters,
      result: { type: 'access_denied' },
      duration_ms: durationMs,
    });
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Ignore
      }
      this.fd = null;
    }
  }
}
