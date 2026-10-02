/**
 * Applies agent session claims (session-claims.ts) to MCP requests against the app's open sessions.
 */

import {
  SessionClaims,
  isProcessAlive,
  type AgentIdentity,
  type ClaimEnvironment,
  type SessionOwner,
} from './session-claims.js';
import {
  SESSION_IN_USE_CODE,
  actingSessionId,
  opensSession,
  sessionInUseMessage,
  terminalSessionId,
} from './agent-requests.js';

export interface SessionLookup {
  readonly mcpConnections: ReadonlyMap<string, {
    readonly session_id: string;
    readonly connection_type: string;
    readonly host: string | null;
    readonly port: number | null;
    readonly created_at: number;
  }>;
  readonly terminalManager: { listSessions(): string[]; isAgentTerminal(sessionId: string): boolean };
  readonly rdpManager: { get(sessionId: string): unknown };
  readonly vncManager: { get(sessionId: string): unknown };
  readonly webManager: { listSessions(): ReadonlyArray<{ readonly id: string }> };
}

interface Response {
  type: 'Success' | 'Error';
  payload: unknown;
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = { ssh: 22, rdp: 3389, vnc: 5900 };

let claims: SessionClaims | null = null;

export function sessionClaims(state: SessionLookup, env?: Partial<ClaimEnvironment>): SessionClaims {
  claims ??= new SessionClaims({
    now: env?.now ?? Date.now,
    isProcessAlive: env?.isProcessAlive ?? isProcessAlive,
    generationOf: env?.generationOf ?? ((id) => state.mcpConnections.get(id)?.created_at ?? null),
  });
  return claims;
}

export function resetSessionClaimsForTest(): void {
  claims = null;
}

export function isSessionOpen(state: SessionLookup, sessionId: string): boolean {
  return state.terminalManager.listSessions().includes(sessionId)
    || !!state.rdpManager.get(sessionId)
    || !!state.vncManager.get(sessionId)
    || state.webManager.listSessions().some((s) => s.id === sessionId);
}

function connectionTypeOf(state: SessionLookup, sessionId: string): string | null {
  const registered = state.mcpConnections.get(sessionId)?.connection_type;
  if (registered) return registered;
  if (state.rdpManager.get(sessionId)) return 'rdp';
  if (state.vncManager.get(sessionId)) return 'vnc';
  if (state.webManager.listSessions().some((s) => s.id === sessionId)) return 'web';
  return null;
}

export function ownerOf(state: SessionLookup, sessionId: string, agent: AgentIdentity | null): SessionOwner {
  return sessionClaims(state).ownerFor(sessionId, agent);
}

export function pruneClosedSessions(state: SessionLookup): void {
  sessionClaims(state).prune((id) => isSessionOpen(state, id));
}

export function sessionInUseResponse(holder: AgentIdentity, connectionType: string | null): Response {
  return {
    type: 'Error',
    payload: { code: SESSION_IN_USE_CODE, message: sessionInUseMessage(holder, connectionType), reason: 'other_agent' },
  };
}

/** Open sessions of a saved RDP or VNC entry: UI tabs use the entry id, MCP ones match host and port. */
export function openSessionsForEntry(
  state: SessionLookup,
  entry: { readonly id: string; readonly entry_type: string; readonly host: string | null | undefined; readonly port: number | null | undefined },
): string[] {
  const port = entry.port ?? DEFAULT_PORTS[entry.entry_type];
  return [...state.mcpConnections.values()]
    .filter((c) => c.connection_type === entry.entry_type)
    .filter((c) => c.session_id === entry.id || (c.host === entry.host && (c.port ?? DEFAULT_PORTS[c.connection_type]) === port))
    .map((c) => c.session_id)
    .filter((id) => isSessionOpen(state, id));
}

function openedSessionId(payload: unknown): string | null {
  const id = (payload as { session_id?: unknown } | null)?.session_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Runs one MCP request under the claim rules: an agent may not act in a session another live agent
 * holds, a session an agent opens or acts in becomes its own, and closing a session frees it. No
 * caller may use the terminal a CLI agent itself runs in.
 */
export async function runWithAgentClaims(
  request: { type: string; payload?: Record<string, unknown> },
  state: SessionLookup,
  agent: AgentIdentity | null,
  dispatch: () => Promise<Response>,
): Promise<Response> {
  const terminalId = terminalSessionId(request.type, request.payload);
  if (terminalId && state.terminalManager.isAgentTerminal(terminalId)) {
    return {
      type: 'Error',
      payload: { code: 'NOT_FOUND', message: `Session not found: ${terminalId}. It is an AI agent's own terminal, which Conduit tools cannot use.` },
    };
  }

  const store = sessionClaims(state);
  const sessionId = actingSessionId(request.type, request.payload);
  let end: (() => void) | null = null;
  if (agent && sessionId && isSessionOpen(state, sessionId)) {
    const begun = store.begin(sessionId, agent);
    if (!begun.ok) return sessionInUseResponse(begun.holder, connectionTypeOf(state, sessionId));
    end = begun.end;
  }

  try {
    const response = await dispatch();
    if (response.type === 'Success') {
      const opened = opensSession(request.type) ? openedSessionId(response.payload) : null;
      if (agent && opened) store.claim(opened, agent);
      if (sessionId && (request.type === 'ConnectionClose' || request.type === 'WebSessionClose')) store.release(sessionId);
    }
    return response;
  } finally {
    end?.();
  }
}
