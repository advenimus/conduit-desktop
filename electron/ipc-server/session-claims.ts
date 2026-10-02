/**
 * Which AI agent is working in which open session, so agents running side by side do not type into
 * each other's sessions. An agent is one Conduit MCP process (every CLI agent starts its own). A
 * session is claimed when an agent opens it or acts in it, and freed when it closes, when the agent's
 * process is gone, or after AGENT_IDLE_RELEASE_MS with no call from that agent.
 */

export interface AgentIdentity {
  readonly id: string;
  readonly pid: number | null;
  /** The MCP client's own name, such as claude-code or codex-mcp-client. */
  readonly client: string | null;
}

export type SessionOwner = 'you' | 'other_agent' | 'free';

// Long enough that an agent between two steps of one task keeps its session (a single
// terminal_execute may run 10 minutes, and calls in flight never expire), short enough that a
// finished agent does not keep a session from the next one for the rest of the day.
export const AGENT_IDLE_RELEASE_MS = 15 * 60_000;

export interface ClaimEnvironment {
  now(): number;
  isProcessAlive(pid: number): boolean;
  /** Changes when a session id is reused for a new session (UI RDP and VNC tabs reuse the entry id). */
  generationOf(sessionId: string): number | null;
}

interface Claim {
  readonly agent: AgentIdentity;
  readonly generation: number | null;
  readonly lastActiveAt: number;
  readonly inFlight: number;
}

export type BeginResult =
  | { readonly ok: true; readonly end: () => void }
  | { readonly ok: false; readonly holder: AgentIdentity };

export class SessionClaims {
  private readonly claims = new Map<string, Claim>();

  constructor(
    private readonly env: ClaimEnvironment,
    private readonly idleMs: number = AGENT_IDLE_RELEASE_MS,
  ) {}

  /** The live agent holding the session, after dropping a claim that has lapsed. */
  holder(sessionId: string): AgentIdentity | null {
    const claim = this.claims.get(sessionId);
    if (!claim) return null;
    if (this.hasLapsed(sessionId, claim)) {
      this.claims.delete(sessionId);
      return null;
    }
    return claim.agent;
  }

  ownerFor(sessionId: string, agent: AgentIdentity | null): SessionOwner {
    const holder = this.holder(sessionId);
    if (!holder) return 'free';
    return agent && holder.id === agent.id ? 'you' : 'other_agent';
  }

  /** Records a session the agent just opened. */
  claim(sessionId: string, agent: AgentIdentity): void {
    this.claims.set(sessionId, this.fresh(sessionId, agent, 0));
  }

  /**
   * Starts an acting call: claims a free session, or refuses when another live agent holds it.
   * The claim cannot lapse for idleness until end() runs.
   */
  begin(sessionId: string, agent: AgentIdentity): BeginResult {
    const holder = this.holder(sessionId);
    if (holder && holder.id !== agent.id) return { ok: false, holder };
    const current = this.claims.get(sessionId);
    this.claims.set(sessionId, current
      ? { ...current, lastActiveAt: this.env.now(), inFlight: current.inFlight + 1 }
      : this.fresh(sessionId, agent, 1));
    let ended = false;
    return {
      ok: true,
      end: () => {
        if (ended) return;
        ended = true;
        const claim = this.claims.get(sessionId);
        if (!claim || claim.agent.id !== agent.id) return;
        this.claims.set(sessionId, { ...claim, lastActiveAt: this.env.now(), inFlight: Math.max(0, claim.inFlight - 1) });
      },
    };
  }

  release(sessionId: string): void {
    this.claims.delete(sessionId);
  }

  /** Drops claims on sessions that no longer exist. */
  prune(isOpen: (sessionId: string) => boolean): void {
    for (const sessionId of [...this.claims.keys()]) {
      if (!isOpen(sessionId)) this.claims.delete(sessionId);
    }
  }

  private fresh(sessionId: string, agent: AgentIdentity, inFlight: number): Claim {
    return { agent, generation: this.env.generationOf(sessionId), lastActiveAt: this.env.now(), inFlight };
  }

  private hasLapsed(sessionId: string, claim: Claim): boolean {
    const generation = this.env.generationOf(sessionId);
    if (claim.generation !== null && generation !== null && generation !== claim.generation) return true;
    if (claim.agent.pid !== null && !this.env.isProcessAlive(claim.agent.pid)) return true;
    return claim.inFlight === 0 && this.env.now() - claim.lastActiveAt > this.idleMs;
  }
}

/** True while a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
