/**
 * Container resolution for materialization (spec 4.6 step 3): dangling targets fall back to
 * root, and cycles among folders (f: edges) or among entries (e: edges) are broken by moving
 * the node whose `container` provisional sibling ranks highest to root.
 * Part of materialize.ts; import through it.
 */

import { CONTAINER_REG, CONTAINER_ROOT, LIFE_LIVE, LIFE_REG, parseContainer } from './catalog.js';
import { compareRank, compareStr } from './sibling.js';
import { provisional, rowKeyStr } from './state-view.js';
import { TBL, type CycleConflict, type RowState, type Sibling, type SyncState } from './types.js';

export interface ContainerResolution {
  /** rowKeyStr -> the container value that materializes (after dangling and cycle fallbacks). */
  readonly effective: ReadonlyMap<string, string>;
  readonly cycles: readonly CycleConflict[];
}

/** Ids of live folders and entries (provisional `_life`; implicit `_life` is live). */
export interface LiveContent {
  readonly folders: ReadonlySet<string>;
  readonly entries: ReadonlySet<string>;
}

interface Node {
  readonly id: string;
  /** Provisional sibling of the `container` register; null when implicit or none eligible. */
  readonly sib: Sibling | null;
  /** Same-table parent id after the dangling fallback; null when none. */
  parent: string | null;
  effective: string;
}

type Graph = Map<string, Node>;

const CYCLE_ON_PATH = 1;
const CYCLE_DONE = 2;

export function isLiveRow(row: RowState): boolean {
  const reg = row.regs.get(LIFE_REG);
  if (!reg) return true;
  return provisional(LIFE_REG, reg.sibs)?.value === LIFE_LIVE;
}

export function collectLiveContent(state: SyncState): LiveContent {
  const folders = new Set<string>();
  const entries = new Set<string>();
  for (const row of state.rows.values()) {
    if (row.key.tbl === TBL.folders && isLiveRow(row)) folders.add(row.key.rowId);
    else if (row.key.tbl === TBL.entries && isLiveRow(row)) entries.add(row.key.rowId);
  }
  return { folders, entries };
}

/** Containers of every live folder and entry (4.6 step 3). */
export function resolveContainers(state: SyncState): ContainerResolution {
  return resolveContainersWith(state, collectLiveContent(state));
}

export function resolveContainersWith(state: SyncState, live: LiveContent): ContainerResolution {
  const folders = buildGraph(state, TBL.folders, live.folders, live);
  const entries = buildGraph(state, TBL.entries, live.entries, live);
  const cycles = [...breakCycles(folders, TBL.folders), ...breakCycles(entries, TBL.entries)];
  const effective = new Map<string, string>();
  for (const node of folders.values()) effective.set(rowKeyStr({ tbl: TBL.folders, rowId: node.id }), node.effective);
  for (const node of entries.values()) effective.set(rowKeyStr({ tbl: TBL.entries, rowId: node.id }), node.effective);
  return { effective, cycles };
}

function buildGraph(state: SyncState, tbl: 1 | 2, ids: ReadonlySet<string>, live: LiveContent): Graph {
  const graph: Graph = new Map();
  for (const id of ids) {
    const reg = state.rows.get(rowKeyStr({ tbl, rowId: id }))?.regs.get(CONTAINER_REG);
    const sib = reg ? provisional(CONTAINER_REG, reg.sibs) : null;
    const value = sib ? sib.value : CONTAINER_ROOT;
    graph.set(id, { id, sib, ...targetOf(tbl, value, live) });
  }
  return graph;
}

/** Folders may sit in root or a live folder; entries in root, a live folder or a live entry. */
function targetOf(tbl: 1 | 2, value: Sibling['value'], live: LiveContent): { parent: string | null; effective: string } {
  const ref = parseContainer(value);
  const root = { parent: null, effective: CONTAINER_ROOT };
  if (!ref || ref.kind === 'r') return root;
  if (ref.kind === 'f') {
    if (!live.folders.has(ref.id)) return root;
    return { parent: tbl === TBL.folders ? ref.id : null, effective: `f:${ref.id}` };
  }
  if (tbl !== TBL.entries || !live.entries.has(ref.id)) return root;
  return { parent: ref.id, effective: `e:${ref.id}` };
}

/**
 * Each node has at most one parent, so every cycle is a disjoint loop and moving one node per
 * loop to root leaves the graph acyclic. Starts are visited in id order for determinism.
 */
function breakCycles(graph: Graph, tbl: 1 | 2): CycleConflict[] {
  const mark = new Map<string, number>();
  const cycles: CycleConflict[] = [];
  for (const start of [...graph.keys()].sort(compareStr)) {
    if (mark.has(start)) continue;
    const path: string[] = [];
    let cur: string | null = start;
    while (cur !== null && !mark.has(cur)) {
      mark.set(cur, CYCLE_ON_PATH);
      path.push(cur);
      cur = graph.get(cur)?.parent ?? null;
    }
    if (cur !== null && mark.get(cur) === CYCLE_ON_PATH) {
      cycles.push(breakCycle(graph, path.slice(path.indexOf(cur)), tbl));
    }
    for (const id of path) mark.set(id, CYCLE_DONE);
  }
  return cycles.sort((a, b) => compareStr(a.rowIds[0], b.rowIds[0]));
}

function breakCycle(graph: Graph, ids: readonly string[], tbl: 1 | 2): CycleConflict {
  let mover = graph.get(ids[0]) as Node;
  for (const id of ids.slice(1)) {
    const node = graph.get(id) as Node;
    if (outranks(node, mover)) mover = node;
  }
  mover.parent = null;
  mover.effective = CONTAINER_ROOT;
  return { kind: 'cycle', tbl, rowIds: [...ids].sort(compareStr), movedToRoot: mover.id };
}

/** Higher container rank wins; two moves stamped with one dot tie, so the larger row id wins. */
function outranks(a: Node, b: Node): boolean {
  if (a.sib && b.sib) {
    const r = compareRank(a.sib, b.sib);
    if (r !== 0) return r > 0;
  } else if (a.sib || b.sib) {
    return a.sib !== null;
  }
  return compareStr(a.id, b.id) > 0;
}
