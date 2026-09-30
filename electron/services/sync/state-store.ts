/**
 * The only module (with schema.ts) that touches SQL. Loads a SyncState, content rows and
 * the sync_row cache from a better-sqlite3 Database, and saves a new state plus a
 * materialize WritePlan back in ONE transaction. Owns the compact on-disk layout of 3.3:
 * rid assignment, implicit registers, head (sync_reg) versus other siblings (sync_sibling),
 * where each head's value lives (content, grave row_json, vault_meta or a carrier row),
 * derived versus explicit pmem, and mat. Spec 3.3, 3.4, 4.6 steps 5-6.
 *
 * Parts: state-store-load.ts (loadFile), state-store-save.ts (saveState, writeStateHeader),
 * state-store-content.ts (content tables, applyWritePlan), state-store-codec.ts (encodings).
 */

export { loadFile } from './state-store-load.js';
export { loadContent, loadContentRows, applyWritePlan } from './state-store-content.js';
export { saveState, writeStateHeader, type SaveInput } from './state-store-save.js';
