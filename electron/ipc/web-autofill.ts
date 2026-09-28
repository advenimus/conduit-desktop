/**
 * Saving the autofill selectors picked in a web session. The save is not an interactive edit of
 * the entry, so an open sync conflict on it stays open (docs/MULTI_DEVICE_SYNC.md 4.2 step 5).
 */

import type { ConduitVault } from '../services/vault/vault.js';

type AutofillVault = Pick<ConduitVault, 'getEntryMeta' | 'updateEntry' | 'runNonInteractive'>;

const SELECTOR_KEYS = ['usernameSelector', 'passwordSelector', 'submitSelector'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Selectors the renderer sent: strings only; anything else is left out. */
export function pickSelectors(selectors: unknown): Record<string, string> {
  if (!isRecord(selectors)) return {};
  const picked: Record<string, string> = {};
  for (const key of SELECTOR_KEYS) {
    const value = selectors[key];
    if (typeof value === 'string') picked[key] = value;
  }
  return picked;
}

/** Merges the selectors into the entry's autofill config (enabled on) and returns that config. */
export function saveAutofillSelectors(vault: AutofillVault, entryId: unknown, selectors: unknown): Record<string, unknown> {
  if (typeof entryId !== 'string' || entryId === '') throw new Error('Invalid entry id');
  const entry = vault.getEntryMeta(entryId);
  const existingConfig = isRecord(entry.config) ? entry.config : {};
  const existingAutofill = isRecord(existingConfig.autofill) ? existingConfig.autofill : {};
  const autofill = { ...existingAutofill, enabled: true, ...pickSelectors(selectors) };
  vault.runNonInteractive(() => vault.updateEntry(entryId, { config: { ...existingConfig, autofill } }));
  return autofill;
}
