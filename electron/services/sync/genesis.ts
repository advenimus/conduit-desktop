/**
 * Genesis and pre-sync files (spec 4.4): G1 builds the first state of a legacy file
 * deterministically (two devices migrating the same bytes produce identical states), new
 * vaults get a random lineage and genesis, G2 absorbs a pre-sync S against the kept baseline
 * (genesis.conduit) with the staleness filter, and G3 adopts the shared file's genesis while
 * offering this device's genesis-only values as a synthetic candidate.
 * Split into genesis-first.ts (G1, new vault), genesis-baseline.ts (G2), genesis-adopt.ts (G3).
 */

export {
  GENESIS_MS,
  contentRowTime,
  contentTable,
  forEachContentRow,
  genesisFromContent,
  newVaultState,
  type GenesisInput,
  type GenesisResult,
  type NewVaultInput,
} from './genesis-first.js';
export { baselineAbsorb, stalenessFilter, type BaselineAbsorbInput } from './genesis-baseline.js';
export { adoptGenesis, isGenesisLevel, isGenesisSibling, type AdoptResult } from './genesis-adopt.js';
