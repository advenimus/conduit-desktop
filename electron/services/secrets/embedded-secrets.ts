/**
 * Embedded secrets: hidden credential entries that hold the values behind secret chips in notes and
 * article bodies (docs/KNOWLEDGE_BASE.md 1.2 and 3). Only user- or agent-initiated saves call this;
 * synced and imported rows are never converted, so two devices can't mint duplicate secrets.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ConduitVault, CreateEntryInput, EntryMeta, UpdateEntryInput } from '../vault/vault.js';
import { readEmbedded, type EmbeddedMeta } from '../knowledge/kb-model.js';
import { planConversion, type PlannedSecret } from './secret-convert-plan.js';
import { formatSecretRef, referencedSecretIds, sanitizeLabel } from './secret-refs.js';

export type SecretVault = Pick<
  ConduitVault,
  'listEntries' | 'getEntryMeta' | 'getEntry' | 'createEntry' | 'updateEntry' | 'deleteEntry' | 'recordPasswordHistory'
>;

export interface TextFields {
  notes?: string | null;
  config?: Record<string, unknown>;
}

export interface ConvertedFields<T extends TextFields> {
  input: T;
  planned: PlannedSecret[];
}

/** Plans conversion of notes and config.content. Nothing is written yet. */
export function planFieldConversion<T extends TextFields>(input: T): ConvertedFields<T> {
  const planned: PlannedSecret[] = [];
  const convert = (text: string) => {
    // One shared id pool per save, so the same value in notes and content maps to one secret.
    const known = new Map(planned.map((p) => [p.value, p]));
    const plan = planConversion(text, uuidv4);
    let out = plan.text;
    for (const secret of plan.created) {
      const existing = known.get(secret.value);
      if (existing) out = out.split(`{{secret:${secret.id}`).join(`{{secret:${existing.id}`);
      else planned.push(secret);
    }
    return out;
  };
  const next = { ...input };
  if (typeof input.notes === 'string') next.notes = convert(input.notes);
  const content = input.config?.content;
  if (typeof content === 'string') next.config = { ...input.config, content: convert(content) };
  return { input: next, planned };
}

/** Creates the planned secrets under `ownerId`, which must already exist. */
export function createPlannedSecrets(vault: SecretVault, ownerId: string, planned: readonly PlannedSecret[]): void {
  for (const secret of planned) {
    vault.createEntry({
      id: secret.id,
      name: secret.label,
      entry_type: 'credential',
      parent_entry_id: ownerId,
      password: secret.value,
      config: { embedded: { owner_id: ownerId, label: secret.label } satisfies EmbeddedMeta },
    });
  }
}

export function createEmbeddedSecret(
  vault: SecretVault,
  ownerId: string,
  label: string,
  value: string,
  { unusedUntilSaved = false }: { unusedUntilSaved?: boolean } = {},
): { id: string; ref: string } {
  const clean = sanitizeLabel(label) || 'Secret';
  const id = uuidv4();
  createPlannedSecrets(vault, ownerId, [{ id, label: clean, value }]);
  // An editor inserts the chip into unsaved text; until that text is saved nothing links to it.
  if (unusedUntilSaved) {
    const meta = vault.getEntryMeta(id);
    vault.updateEntry(id, { config: { ...meta.config, embedded: { ...readEmbedded(meta.config)!, orphaned_at: new Date().toISOString() } } });
  }
  return { id, ref: formatSecretRef(id, clean) };
}

export function ownedSecrets(vault: SecretVault, ownerId: string): EntryMeta[] {
  return vault.listEntries().filter((e) => e.entry_type === 'credential' && readEmbedded(e.config)?.owner_id === ownerId);
}

/** Every secret id linked from notes, document/article bodies or article history (3.3). */
function allReferencedIds(vault: SecretVault): Set<string> {
  const ids = new Set<string>();
  const add = (text: unknown) => {
    if (typeof text === 'string') for (const id of referencedSecretIds(text)) ids.add(id);
  };
  for (const e of vault.listEntries()) {
    add(e.notes);
    add(e.config?.content);
    // A revision can be restored, so a secret it links to is still in use.
    const history = e.config?.kb_history;
    if (Array.isArray(history)) for (const rev of history) add((rev as { content?: unknown })?.content);
  }
  return ids;
}

/** Sets or clears orphaned_at on the owner's secrets (3.3). Returns how many are orphaned now. */
export function refreshOrphans(vault: SecretVault, ownerId: string, now = new Date().toISOString()): number {
  const referenced = allReferencedIds(vault);
  let orphans = 0;
  for (const secret of ownedSecrets(vault, ownerId)) {
    const meta = readEmbedded(secret.config)!;
    if (meta.pending_for) continue;
    const isReferenced = referenced.has(secret.id);
    if (!isReferenced) orphans++;
    if (isReferenced === !meta.orphaned_at) continue;
    const { orphaned_at: _drop, ...rest } = meta;
    const embedded = isReferenced ? rest : { ...meta, orphaned_at: now };
    vault.updateEntry(secret.id, { config: { ...secret.config, embedded } });
  }
  return orphans;
}

export function cleanupOrphans(vault: SecretVault, ownerId: string): number {
  const orphans = ownedSecrets(vault, ownerId).filter((s) => readEmbedded(s.config)?.orphaned_at);
  for (const s of orphans) vault.deleteEntry(s.id);
  return orphans.length;
}

/** Converts notes/content in an update to an existing entry, then saves it. */
export function updateWithSecrets(
  vault: SecretVault,
  id: string,
  input: UpdateEntryInput,
  { checkOrphans = true }: { checkOrphans?: boolean } = {},
): { entry: EntryMeta; converted: number } {
  if (input.notes === undefined && input.config === undefined) return { entry: vault.updateEntry(id, input), converted: 0 };
  const { input: next, planned } = planFieldConversion(input);
  createPlannedSecrets(vault, id, planned);
  const entry = vault.updateEntry(id, next);
  if (checkOrphans) refreshOrphans(vault, id);
  return { entry, converted: planned.length };
}

/** Creates an entry whose notes/content may hold !!value!!; its secrets are created right after it. */
export function createWithSecrets(vault: SecretVault, input: CreateEntryInput): { entry: EntryMeta; converted: number } {
  const { input: next, planned } = planFieldConversion({ ...input, id: input.id ?? uuidv4() });
  const entry = vault.createEntry(next);
  createPlannedSecrets(vault, entry.id, planned);
  return { entry, converted: planned.length };
}

/** Copies the secrets `toId`'s text borrowed from `fromId` so a duplicate owns its own (used after duplicating). */
export function cloneBorrowedSecrets(vault: SecretVault, fromId: string, toId: string): number {
  const target = vault.getEntryMeta(toId);
  const fields: TextFields = { notes: target.notes, config: target.config };
  let notes = fields.notes ?? null;
  let content = typeof fields.config?.content === 'string' ? (fields.config.content as string) : null;
  let cloned = 0;
  for (const secret of ownedSecrets(vault, fromId)) {
    const usedIn = [notes, content].some((t) => t !== null && referencedSecretIds(t).has(secret.id));
    if (!usedIn) continue;
    const value = vault.getEntry(secret.id).password ?? '';
    const copy = createEmbeddedSecret(vault, toId, secret.name, value);
    const swap = (t: string | null) => (t === null ? null : t.split(`{{secret:${secret.id}`).join(`{{secret:${copy.id}`));
    notes = swap(notes);
    content = swap(content);
    cloned++;
  }
  if (cloned > 0) {
    vault.updateEntry(toId, {
      notes,
      ...(content !== null ? { config: { ...target.config, content } } : {}),
    });
  }
  return cloned;
}

// ---- Rotation (3.4) ----

function pendingFor(vault: SecretVault, secretId: string): EntryMeta | undefined {
  return vault.listEntries().find((e) => e.entry_type === 'credential' && readEmbedded(e.config)?.pending_for === secretId);
}

export function stageRotation(vault: SecretVault, secretId: string, value: string): { pendingRef: string } {
  const original = vault.getEntryMeta(secretId);
  if (original.entry_type !== 'credential') throw new Error('Only secrets and credentials can be rotated.');
  const existing = pendingFor(vault, secretId);
  if (existing) vault.deleteEntry(existing.id);
  const ownerId = readEmbedded(original.config)?.owner_id ?? original.parent_entry_id ?? secretId;
  vault.createEntry({
    name: `${original.name} (new)`,
    entry_type: 'credential',
    parent_entry_id: ownerId,
    password: value,
    config: { embedded: { owner_id: ownerId, label: original.name, pending_for: secretId } satisfies EmbeddedMeta },
  });
  return { pendingRef: `{{secret:${secretId}.pending}}` };
}

export function commitRotation(vault: SecretVault, secretId: string, changedBy: string | null): void {
  const pending = pendingFor(vault, secretId);
  if (!pending) throw new Error('This secret has no staged rotation. Call secret_rotate first.');
  const current = vault.getEntry(secretId);
  const next = vault.getEntry(pending.id).password;
  vault.recordPasswordHistory(secretId, current.username, current.password, changedBy);
  vault.updateEntry(secretId, { password: next });
  vault.deleteEntry(pending.id);
}

export function discardRotation(vault: SecretVault, secretId: string): boolean {
  const pending = pendingFor(vault, secretId);
  if (pending) vault.deleteEntry(pending.id);
  return !!pending;
}

// ---- Vault-wide ----

export interface EncryptAllResult {
  entries: number;
  secrets: number;
}

/** "Encrypt secrets in all notes": converts every entry whose notes or content still hold !!value!!. */
export function encryptAllPlaintext(vault: SecretVault): EncryptAllResult {
  let entries = 0;
  let secrets = 0;
  for (const e of vault.listEntries()) {
    const { planned } = planFieldConversion({ notes: e.notes, config: e.config });
    if (planned.length === 0) continue;
    // Converting only adds refs, so no secret becomes unused; skipping the vault-wide orphan scan keeps this linear.
    const { converted } = updateWithSecrets(vault, e.id, { notes: e.notes, config: e.config }, { checkOrphans: false });
    entries++;
    secrets += converted;
  }
  return { entries, secrets };
}
