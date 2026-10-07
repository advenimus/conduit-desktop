import type { AgentIdentity } from './session-claims.js';

const KNOWN: ReadonlyArray<[RegExp, string]> = [
  [/claude/i, 'Claude Code'],
  [/codex/i, 'Codex'],
  [/cursor/i, 'Cursor'],
  [/gemini/i, 'Gemini'],
  [/grok/i, 'Grok'],
  [/opencode/i, 'OpenCode'],
];

/** A name people recognise for the agent behind an MCP client, e.g. "codex-mcp-client" → "Codex". */
export function agentDisplayName(agent: AgentIdentity | null): string {
  const client = agent?.client?.trim();
  if (!client) return 'An AI agent';
  return KNOWN.find(([re]) => re.test(client))?.[1] ?? client.slice(0, 40);
}
