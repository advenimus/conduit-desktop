/**
 * Register catalog (spec 3.5), the single import point for catalog-defs.ts (definitions,
 * keys, normalization, containers) and catalog-rows.ts (reading and building content rows).
 * Shared by capture, materialize, conflicts and genesis. Fully implemented.
 */

export * from './catalog-defs.js';
export * from './catalog-rows.js';
