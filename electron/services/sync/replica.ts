/**
 * The device's replica of one lineage (spec 3.1, 3.2, 4.1, 4.2 step 6, 4.4 G1, 5.1, 6.3 step 6):
 * the lineage folder, opening or creating W through the WorkingCopyHost (one shared
 * connection with ConduitVault), G1 genesis and "adopt a synced S" on first open, the
 * per-launch incarnation and dev, the high-water check, the HLC, the in-memory W snapshot and
 * generation counter, the capture hooks ConduitVault calls inside each mutator, commits
 * (materialize + saveState), the key ring, local.json ownership, and the new-build password
 * change.
 *
 * Parts: replica-types.ts (constants, shapes), replica-incarnation.ts (IncarnationRegistry),
 * replica-open.ts (openReplica), replica-seed.ts (genesis, adopt, new vault),
 * replica-core.ts (the open replica), replica-commit.ts (materialize + save, reload),
 * replica-events.ts (listeners), replica-scan.ts (machine folder scans).
 */

export * from './replica-types.js';
export { IncarnationRegistry } from './replica-incarnation.js';
export { openReplica } from './replica-open.js';
export { INVALID_PASSWORD_MESSAGE } from './replica-core.js';
export { findBoundLineage, hasWorkingCopy, readPendingSummaries } from './replica-scan.js';
