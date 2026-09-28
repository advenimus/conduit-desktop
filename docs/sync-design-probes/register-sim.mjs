// Property simulation for the single-register merge rule in the sync design.
// App siblings: dot (dev>0, ms, c), covered via version vector.
// Pseudo siblings (legacy/genesis): dev=0, identity (ms, vh), covered via per-register pmem {ms, vhs}.

let seed = Number(process.argv[2] ?? 1);
function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
function ri(n) { return Math.floor(rnd() * n); }

const cmpDot = (a, b) => (a.ms - b.ms) || (a.c - b.c) || (a.dev - b.dev);
const pid = (s) => `${s.vh}|${s.base}`;
const sibKey = (s) => s.dev === 0 ? `p:${s.ms}:${pid(s)}` : `a:${s.dev}:${s.ms}:${s.c}`;

function vvCovers(vv, s) {
  const e = vv.get(s.dev);
  return !!e && (e.ms > s.ms || (e.ms === s.ms && e.c >= s.c));
}
function pmemCovers(pm, s) {
  return !!pm && (pm.ms > s.ms || (pm.ms === s.ms && pm.vhs.has(pid(s))));
}
function covered(state, s) { return s.dev === 0 ? pmemCovers(state.pmem, s) : vvCovers(state.vv, s); }

function joinPmem(a, b) {
  if (!a) return b && { ms: b.ms, vhs: new Set(b.vhs) };
  if (!b) return { ms: a.ms, vhs: new Set(a.vhs) };
  if (a.ms !== b.ms) { const w = a.ms > b.ms ? a : b; return { ms: w.ms, vhs: new Set(w.vhs) }; }
  return { ms: a.ms, vhs: new Set([...a.vhs, ...b.vhs]) };
}
function joinVV(a, b) {
  const out = new Map(a);
  for (const [d, e] of b) { const x = out.get(d); if (!x || x.ms < e.ms || (x.ms === e.ms && x.c < e.c)) out.set(d, e); }
  return out;
}

function collapse(sibs) {
  const byVh = new Map();
  for (const s of sibs) {
    const cur = byVh.get(s.vh);
    if (!cur) { byVh.set(s.vh, s); continue; }
    // app beats pseudo; within class keep max dot
    const better = (cur.dev === 0) !== (s.dev === 0) ? (s.dev !== 0 ? s : cur) : (cmpDot(s, cur) > 0 ? s : cur);
    byVh.set(s.vh, better);
  }
  return [...byVh.values()].sort((a, b) => sibKey(a) < sibKey(b) ? -1 : 1);
}

function merge(A, B) {
  const inB = new Set(B.sibs.map(sibKey)), inA = new Set(A.sibs.map(sibKey));
  const keep = [];
  for (const s of A.sibs) if (inB.has(sibKey(s)) || !covered(B, s)) keep.push(s);
  for (const s of B.sibs) if (!inA.has(sibKey(s)) && !covered(A, s)) keep.push(s);
  return {
    vv: joinVV(A.vv, B.vv), pmem: joinPmem(A.pmem, B.pmem), sibs: keep.sort((a, b) => sibKey(a) < sibKey(b) ? -1 : 1),
    hist: new Set([...A.hist, ...B.hist]),
  };
}

const winner = (sibs) => sibs.reduce((w, s) => (!w || cmpDot(s, w) > 0 ? s : w), null);
const norm = (st) => JSON.stringify({
  vv: [...st.vv].sort((a, b) => a[0] - b[0]),
  pm: st.pmem && { ms: st.pmem.ms, vhs: [...st.pmem.vhs].sort() },
  sibs: st.sibs.map(sibKey).sort(),
});

// Oracle: writes with explicit causal pasts plus the intended legacy-vs-legacy LWW.
const writes = new Map();
function maximalValues(allIds) {
  const ids = [...allIds];
  const precedes = (a, b) => {
    // a before b if a in closure of b's past, or both pseudo with a.ms < b.ms
    const seen = new Set(); const stack = [b];
    while (stack.length) {
      const x = stack.pop();
      for (const p of writes.get(x).past) { if (p === a || (writes.get(a).ident && writes.get(p).ident === writes.get(a).ident)) return true; if (!seen.has(p)) { seen.add(p); stack.push(p); } }
      const wx = writes.get(x);
      if (wx.pseudo) for (const y of ids) { const wy = writes.get(y); if (wy.pseudo && wy.ms < wx.ms && !seen.has(y)) { if (y === a) return true; seen.add(y); stack.push(y); } }
    }
    return false;
  };
  const max = ids.filter((a) => !ids.some((b) => b !== a && precedes(a, b)));
  return new Set(max.map((id) => writes.get(id).vh));
}

let nextId = 1;
function appWrite(st, dev, hlc) {
  const prev = st.vv.get(dev); const ms = Math.max(hlc.now++, prev ? prev.ms : 0); const c = prev && prev.ms === ms ? prev.c + 1 : 0;
  const vh = 'v' + ri(4); const id = nextId++;
  writes.set(id, { past: new Set(st.hist), vh, pseudo: false });
  const s = { dev, ms, c, vh, id };
  const vv = new Map(st.vv); vv.set(dev, { ms, c });
  return { vv, pmem: st.pmem, sibs: [s], hist: new Set([...st.hist, id]) };
}
function legacyWrite(st) {
  const w = winner(st.sibs); const others = st.sibs.filter((s) => s !== w && s.dev !== 0);
  const vh = 'v' + ri(4);
  if (w && w.vh === vh) return st; // no change detected
  const hint = ri(40); const ms = Math.max(hint, (st.pmem ? st.pmem.ms : 0) + 1);
  const id = nextId++;
  const otherIds = new Set(others.map((s) => s.id));
  writes.set(id, { past: new Set([...st.hist].filter((x) => !otherIds.has(x))), vh, pseudo: true, ms, ident: `${ms}|${vh}|${w ? sibKey(w) : 'none'}` });
  const base = w ? sibKey(w) : 'none';
  const s = { dev: 0, ms, c: 0, vh, id, base };
  return { vv: st.vv, pmem: joinPmem(st.pmem, { ms, vhs: new Set([pid(s)]) }), sibs: [...others, s], hist: new Set([...st.hist, id]) };
}
function genesis() {
  const vh = 'v' + ri(3); const key = `g:${vh}`;
  if (!writes.has(key)) writes.set(key, { past: new Set(), vh, pseudo: true, ms: 0, ident: `0|${vh}|none` });
  return { vv: new Map(), pmem: { ms: 0, vhs: new Set([`${vh}|none`]) }, sibs: [{ dev: 0, ms: 0, c: 0, vh, id: key, base: 'none' }], hist: new Set([key]) };
}

let failures = 0;
const runs = Number(process.argv[3] ?? 3000);
for (let r = 0; r < runs; r++) {
  writes.clear(); nextId = 1;
  const n = 2 + ri(4); const hlc = { now: 1 };
  let R = Array.from({ length: n }, () => genesis());
  const steps = 8 + ri(20); for (let step = 0; step < steps; step++) {
    const i = ri(n), op = ri(10);
    if (op < 4) R[i] = appWrite(R[i], i + 1, hlc);
    else if (op < 6) R[i] = legacyWrite(R[i]);
    else { const j = ri(n); R[i] = merge(R[i], R[j]); }
    // algebraic laws on random triples
    const a = R[ri(n)], b = R[ri(n)], c = R[ri(n)];
    if (norm(merge(a, b)) !== norm(merge(b, a))) { failures++; console.log('commutativity', r, step); }
    if (norm(merge(merge(a, b), c)) !== norm(merge(a, merge(b, c)))) { failures++; console.log('associativity', r, step); }
    if (norm(merge(a, a)) !== norm(a)) { failures++; console.log('idempotence', r, step); }
  }
  let all = R.reduce((acc, s) => merge(acc, s));
  R = R.map((s) => merge(s, all));
  if (new Set(R.map(norm)).size !== 1) { failures++; console.log('convergence', r); }
  const got = new Set(all.sibs.map((s) => s.vh));
  const want = maximalValues(all.hist);
  const eq = got.size === want.size && [...got].every((v) => want.has(v));
  if (!eq) { failures++; if (failures < 10) console.log('oracle mismatch run', r, 'got', [...got], 'want', [...want]); }
}
console.log(`runs=${runs} failures=${failures}`);
