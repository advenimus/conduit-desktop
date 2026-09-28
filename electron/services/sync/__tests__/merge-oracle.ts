// Test-only no-lost-write oracle, ported from register-sim.mjs maximalValues(): every write
// records its causal past; the merged register must hold exactly the maximal writes. Pseudo
// writes are ordered by the legacy clock (smaller ms precedes larger ms) unless the later write
// explicitly kept the earlier sibling (rule R re-assertions keep dead siblings).

export interface WriteRec {
  /** sibling.ts identityKey() of the sibling the write created. */
  readonly identity: string;
  /** vhash of the written value (before any redaction or stale-key flagging). */
  readonly vhash: string;
  readonly pseudo: boolean;
  readonly ms: number;
  /** Write ids (of the same register) the writer had seen and replaced. */
  readonly past: ReadonlySet<string>;
  /** Identities of pseudo siblings a pseudo write deliberately kept. */
  readonly keptPseudo: ReadonlySet<string>;
}

export type RegisterWrites = ReadonlyMap<string, WriteRec>;

function mustGet(writes: RegisterWrites, id: string): WriteRec {
  const w = writes.get(id);
  if (!w) throw new Error(`oracle: unknown write ${id}`);
  return w;
}

function sameWrite(a: WriteRec, other: WriteRec): boolean {
  return a.pseudo && other.pseudo && a.identity === other.identity;
}

function pseudoPredecessors(writes: RegisterWrites, ids: readonly string[], x: WriteRec): string[] {
  if (!x.pseudo) return [];
  return ids.filter((y) => {
    const wy = mustGet(writes, y);
    return wy.pseudo && wy.ms < x.ms && !x.keptPseudo.has(wy.identity);
  });
}

/** a precedes b: a is in b's causal closure, or ordered before it by the legacy clock. */
export function precedes(writes: RegisterWrites, ids: readonly string[], a: string, b: string): boolean {
  const wa = mustGet(writes, a);
  const seen = new Set<string>();
  const stack = [b];
  while (stack.length > 0) {
    const wx = mustGet(writes, stack.pop() as string);
    const next = [...wx.past, ...pseudoPredecessors(writes, ids, wx)];
    for (const p of next) {
      if (p === a || sameWrite(wa, mustGet(writes, p))) return true;
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return false;
}

/** The writes no other write in `ids` supersedes. */
export function maximalWrites(writes: RegisterWrites, ids: ReadonlySet<string>): WriteRec[] {
  const list = [...ids];
  return list
    .filter((a) => !list.some((b) => b !== a && precedes(writes, list, a, b)))
    .map((id) => mustGet(writes, id));
}
