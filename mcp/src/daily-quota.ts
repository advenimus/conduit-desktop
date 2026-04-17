/**
 * Daily tool-call quota manager for MCP.
 *
 * Enforces a rolling 24-hour cap on tool invocations for users on tiers
 * that include a daily quota (e.g. Free tier: 50/day). Pass quota=-1 to
 * disable enforcement (unlimited tiers).
 *
 * Storage: JSON file at {dataDir}/mcp-quota.json
 * Format: { calls: number[] }  // epoch-ms timestamps
 *
 * Honor-system: local enforcement. Users who modify the source can bypass,
 * which is an accepted risk — the real moat is the backend (cloud sync,
 * team vault, Stripe). The 1% of users who would tamper were not going to
 * pay anyway.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDataDir } from './data-dir.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface QuotaFile {
  calls: number[];
}

export interface QuotaCheckResult {
  allowed: boolean;
  count: number;
  remaining: number;
  resetAt: number | null; // epoch-ms when oldest call falls off the rolling window
}

export class DailyQuotaManager {
  private filePath: string;
  private cache: number[] | null = null;

  constructor(filePath?: string) {
    if (filePath) {
      this.filePath = filePath;
    } else {
      const dataDir = getDataDir();
      this.filePath = path.join(dataDir, 'mcp-quota.json');
    }
  }

  /**
   * Check whether a tool call is allowed under the given quota.
   * quota = -1 means unlimited (always allowed).
   */
  check(quota: number): QuotaCheckResult {
    if (quota === -1) {
      return { allowed: true, count: 0, remaining: -1, resetAt: null };
    }

    const now = Date.now();
    const calls = this.loadAndPrune(now);
    const count = calls.length;
    const remaining = Math.max(0, quota - count);
    const allowed = count < quota;
    const resetAt = count > 0 ? calls[0] + DAY_MS : null;

    return { allowed, count, remaining, resetAt };
  }

  /**
   * Record a successful tool call. Prunes old entries as a side effect.
   */
  record(): void {
    const now = Date.now();
    const calls = this.loadAndPrune(now);
    calls.push(now);
    this.save(calls);
  }

  private loadAndPrune(now: number): number[] {
    if (this.cache === null) {
      this.cache = this.loadFromDisk();
    }
    const cutoff = now - DAY_MS;
    this.cache = this.cache.filter((ts) => ts > cutoff);
    return this.cache;
  }

  private loadFromDisk(): number[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as QuotaFile;
      if (!Array.isArray(parsed.calls)) return [];
      return parsed.calls.filter((n) => typeof n === 'number');
    } catch {
      // Corrupt file — start fresh
      return [];
    }
  }

  private save(calls: number[]): void {
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Directory already exists or parent readonly — will surface on write
    }

    const data: QuotaFile = { calls };
    // Atomic write via temp file + rename (avoids torn writes on crash)
    const tmpPath = path.join(
      dir,
      `.mcp-quota-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      // Best-effort cleanup; never throw from a record/save path
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      // Swallow the error so tool calls aren't blocked by disk issues.
      process.stderr.write(
        `[mcp-quota] Failed to persist quota file: ${err instanceof Error ? err.message : String(err)}${os.EOL}`,
      );
    }
  }
}
