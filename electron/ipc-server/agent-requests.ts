/**
 * How MCP requests relate to agent session claims (session-claims.ts): who sent a request, which
 * session it acts in, and which requests open a new session. Reading (screens, screenshots, lists)
 * is never refused; only requests that type, click, navigate or close are.
 */

import type { AgentIdentity } from './session-claims.js';

const MAX_AGENT_ID_LENGTH = 128;
const MAX_CLIENT_NAME_LENGTH = 64;

/**
 * The `agent` field MCP builds with session ownership add beside type and payload. Older MCP builds
 * send none and are never claimed or refused.
 */
export function parseAgentIdentity(raw: unknown): AgentIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, pid, client } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_AGENT_ID_LENGTH) return null;
  return {
    id,
    pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null,
    client: typeof client === 'string' && client.length > 0 ? client.slice(0, MAX_CLIENT_NAME_LENGTH) : null,
  };
}

const ACTING_REQUESTS: Readonly<Record<string, string>> = {
  TerminalWrite: 'session_id',
  TerminalExecute: 'session_id',
  TerminalSendKeys: 'session_id',
  ConnectionClose: 'id',
  RdpClick: 'connection_id',
  RdpType: 'connection_id',
  RdpSendKey: 'connection_id',
  RdpMouseMove: 'connection_id',
  RdpMouseDrag: 'connection_id',
  RdpMouseScroll: 'connection_id',
  RdpResize: 'connection_id',
  VncClick: 'connection_id',
  VncType: 'connection_id',
  VncSendKey: 'connection_id',
  VncMouseMove: 'connection_id',
  VncMouseScroll: 'connection_id',
  VncMouseDrag: 'connection_id',
  WebSessionClose: 'session_id',
  WebSessionNavigate: 'session_id',
  WebSessionClick: 'session_id',
  WebSessionType: 'session_id',
  WebSessionSendKey: 'session_id',
  WebSessionMouseMove: 'session_id',
  WebSessionMouseDrag: 'session_id',
  WebSessionMouseScroll: 'session_id',
  WebSessionClickElement: 'session_id',
  WebSessionFillInput: 'session_id',
  WebSessionExecuteJs: 'session_id',
  WebSessionCreateTab: 'session_id',
  WebSessionCloseTab: 'session_id',
  WebSessionSwitchTab: 'session_id',
  WebSessionGoBack: 'session_id',
  WebSessionGoForward: 'session_id',
  WebSessionReload: 'session_id',
};

const TERMINAL_REQUESTS = new Set([
  'TerminalWrite', 'TerminalReadBuffer', 'TerminalExecute', 'TerminalSendKeys', 'TerminalReadScreen', 'ConnectionClose',
]);

const SESSION_OPENING_REQUESTS = new Set(['LocalShellCreate', 'ConnectionOpen', 'ConnectionOpenEntry', 'WebSessionCreate']);

function idField(payload: Record<string, unknown> | undefined, field: string): string | null {
  const value = payload?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The session an acting request works in, or null for reads and requests without a session. */
export function actingSessionId(type: string, payload: Record<string, unknown> | undefined): string | null {
  const field = ACTING_REQUESTS[type];
  return field ? idField(payload, field) : null;
}

/** The terminal session a request reads or writes, used to keep MCP out of agents' own terminals. */
export function terminalSessionId(type: string, payload: Record<string, unknown> | undefined): string | null {
  if (!TERMINAL_REQUESTS.has(type)) return null;
  return idField(payload, type === 'ConnectionClose' ? 'id' : 'session_id');
}

export function opensSession(type: string): boolean {
  return SESSION_OPENING_REQUESTS.has(type);
}

export const SESSION_IN_USE_CODE = 'SESSION_IN_USE';

/** The agent's own name for errors, e.g. "another agent (codex-mcp-client)". */
export function describeAgent(agent: AgentIdentity): string {
  return agent.client ? `another agent (${agent.client})` : 'another agent';
}

/** Protocols where a second session to the same machine is not a separate workspace. */
export function isSharedScreenProtocol(connectionType: string | null): boolean {
  return connectionType === 'rdp' || connectionType === 'vnc' || connectionType === 'web';
}

export function sessionInUseMessage(holder: AgentIdentity, connectionType: string | null): string {
  const who = describeAgent(holder);
  if (isSharedScreenProtocol(connectionType)) {
    const kind = connectionType === 'web' ? 'web session' : `${connectionType?.toUpperCase()} session`;
    const why = connectionType === 'web'
      ? 'Do not use it.'
      : 'Do not use it, and do not open a second one: another login to the same machine can disconnect it.';
    return `${who[0].toUpperCase()}${who.slice(1)} is working in this ${kind}. ${why} ` +
      'Tell the user it is busy and ask whether to wait. Reading it (screenshots) is still allowed.';
  }
  return `${who[0].toUpperCase()}${who.slice(1)} is working in this session. Do not type into it. ` +
    'Open your own session for the same entry with connection_open_entry (use the entry_id from connection_list), ' +
    'or local_shell_create for a local shell. Reading it (terminal_read_pane) is still allowed.';
}
