/**
 * Replaces vault secret values found in text an agent is about to read (terminal screens, command
 * output, page content) with a ref or a placeholder. Best effort: it cannot see screenshots, and an
 * agent that encodes a value on purpose gets past it. It stops accidents, not a hostile agent.
 */

import { readEmbedded } from '../knowledge/kb-model.js';
import { formatSecretRef } from './secret-refs.js';

export const MIN_SCRUB_LENGTH = 6;

export interface ScrubVault {
  isUnlocked(): boolean;
  listEntries(): Array<{ id: string; name: string; entry_type: string; config: unknown; updated_at: string }>;
  getEntry(id: string): { password: string | null; private_key?: string | null };
}

interface Needle {
  value: string;
  replacement: string;
}

function replacementFor(entry: { id: string; name: string; entry_type: string; config: unknown }): string {
  if (entry.entry_type === 'credential' && readEmbedded(entry.config)) return formatSecretRef(entry.id, entry.name);
  return entry.entry_type === 'credential' ? `[credential: ${entry.name}]` : `[password: ${entry.name}]`;
}

export class SecretScrubber {
  private signature: string | null = null;
  private needles: Needle[] = [];

  /** Drops every cached value; call on lock. */
  clear(): void {
    this.signature = null;
    this.needles = [];
  }

  private refresh(vault: ScrubVault): void {
    if (!vault.isUnlocked()) {
      this.clear();
      return;
    }
    const entries = vault.listEntries();
    const signature = `${entries.length}:${entries.reduce((max, e) => (e.updated_at > max ? e.updated_at : max), '')}`;
    if (signature === this.signature) return;

    const needles: Needle[] = [];
    for (const entry of entries) {
      let full: { password: string | null; private_key?: string | null };
      try {
        full = vault.getEntry(entry.id);
      } catch {
        continue;
      }
      const replacement = replacementFor(entry);
      for (const value of [full.password, full.private_key]) {
        if (value && value.length >= MIN_SCRUB_LENGTH) needles.push({ value, replacement });
      }
    }
    // Longest first, so a secret that contains another is replaced whole.
    needles.sort((a, b) => b.value.length - a.value.length);
    this.needles = needles;
    this.signature = signature;
  }

  scrub(vault: ScrubVault, text: string, extra: ReadonlyArray<{ value: string; replacement: string }> = []): string {
    this.refresh(vault);
    let out = text;
    const needles = extra.length ? [...extra, ...this.needles].sort((a, b) => b.value.length - a.value.length) : this.needles;
    for (const { value, replacement } of needles) {
      if (value && out.includes(value)) out = out.split(value).join(replacement);
    }
    return out;
  }

  /** Scrubs every string inside a JSON-like value. */
  scrubDeep<T>(vault: ScrubVault, value: T, extra: ReadonlyArray<{ value: string; replacement: string }> = []): T {
    if (typeof value === 'string') return this.scrub(vault, value, extra) as T;
    if (Array.isArray(value)) return value.map((v) => this.scrubDeep(vault, v, extra)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.scrubDeep(vault, v, extra)])) as T;
    }
    return value;
  }
}
