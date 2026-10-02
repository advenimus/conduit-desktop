// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AGENT_IDLE_RELEASE_MS, SessionClaims, isProcessAlive, type AgentIdentity } from '../session-claims.js';

const A: AgentIdentity = { id: 'agent-a', pid: 101, client: 'claude-code' };
const B: AgentIdentity = { id: 'agent-b', pid: 202, client: 'codex-mcp-client' };

function setup() {
  const env = {
    time: 1_000,
    dead: new Set<number>(),
    generations: new Map<string, number>(),
  };
  const claims = new SessionClaims({
    now: () => env.time,
    isProcessAlive: (pid) => !env.dead.has(pid),
    generationOf: (id) => env.generations.get(id) ?? null,
  });
  return { env, claims };
}

describe('SessionClaims', () => {
  it('leaves sessions free until an agent acts in them', () => {
    const { claims } = setup();
    expect(claims.ownerFor('s1', A)).toBe('free');
    expect(claims.ownerFor('s1', null)).toBe('free');
  });

  it('gives a session to the first agent that acts and refuses the next one', () => {
    const { claims } = setup();
    const first = claims.begin('s1', A);
    expect(first.ok).toBe(true);
    if (first.ok) first.end();
    expect(claims.ownerFor('s1', A)).toBe('you');
    expect(claims.ownerFor('s1', B)).toBe('other_agent');
    expect(claims.ownerFor('s1', null)).toBe('other_agent');
    const second = claims.begin('s1', B);
    expect(second).toEqual({ ok: false, holder: A });
  });

  it('lets the holder keep acting', () => {
    const { claims } = setup();
    claims.claim('s1', A);
    const again = claims.begin('s1', A);
    expect(again.ok).toBe(true);
  });

  it('frees the session when the holder process is gone', () => {
    const { env, claims } = setup();
    claims.claim('s1', A);
    env.dead.add(A.pid!);
    expect(claims.ownerFor('s1', B)).toBe('free');
    expect(claims.begin('s1', B).ok).toBe(true);
    expect(claims.ownerFor('s1', B)).toBe('you');
  });

  it('frees an idle session after the idle time, but never while a call is running', () => {
    const { env, claims } = setup();
    const running = claims.begin('s1', A);
    env.time += AGENT_IDLE_RELEASE_MS + 1;
    expect(claims.ownerFor('s1', B)).toBe('other_agent');
    if (running.ok) running.end();
    expect(claims.ownerFor('s1', B)).toBe('other_agent');
    env.time += AGENT_IDLE_RELEASE_MS;
    expect(claims.ownerFor('s1', B)).toBe('other_agent');
    env.time += 1;
    expect(claims.ownerFor('s1', B)).toBe('free');
  });

  it('ignores a repeated end()', () => {
    const { env, claims } = setup();
    const one = claims.begin('s1', A);
    const two = claims.begin('s1', A);
    if (!one.ok || !two.ok) throw new Error('expected both to start');
    one.end();
    one.end();
    env.time += AGENT_IDLE_RELEASE_MS + 1;
    expect(claims.ownerFor('s1', B)).toBe('other_agent');
    two.end();
    env.time += AGENT_IDLE_RELEASE_MS + 1;
    expect(claims.ownerFor('s1', B)).toBe('free');
  });

  it('drops a claim when the session id is reused for a new session', () => {
    const { env, claims } = setup();
    env.generations.set('entry-1', 1);
    claims.claim('entry-1', A);
    expect(claims.ownerFor('entry-1', B)).toBe('other_agent');
    env.generations.set('entry-1', 2);
    expect(claims.ownerFor('entry-1', B)).toBe('free');
  });

  it('keeps an agent without a pid until it goes idle', () => {
    const { env, claims } = setup();
    claims.claim('s1', { id: 'no-pid', pid: null, client: null });
    expect(claims.ownerFor('s1', B)).toBe('other_agent');
    env.time += AGENT_IDLE_RELEASE_MS + 1;
    expect(claims.ownerFor('s1', B)).toBe('free');
  });

  it('releases on close and prunes sessions that no longer exist', () => {
    const { claims } = setup();
    claims.claim('s1', A);
    claims.claim('s2', A);
    claims.release('s1');
    expect(claims.ownerFor('s1', B)).toBe('free');
    claims.prune((id) => id !== 's2');
    expect(claims.ownerFor('s2', B)).toBe('free');
  });
});

describe('isProcessAlive', () => {
  it('is true for this process and false for a pid that cannot exist', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });
});
