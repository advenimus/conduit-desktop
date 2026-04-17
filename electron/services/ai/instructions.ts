/**
 * Centralized AI instruction text — single source of truth for all prompt variants.
 *
 * Used by:
 * - Claude Code engine append (claude-code-engine.ts)
 * - External agent instruction files (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md)
 */

import { TOOL_REGISTRY } from './tool-registry.js';

// ── Reusable instruction sections ────────────────────────────────────────────

const DESCRIPTION =
  'Conduit is a cross-platform remote connection manager with AI integration. ' +
  'It manages SSH, RDP, VNC, and web connections with an encrypted credential vault.';

const CAPABILITIES = [
  'Manage connections (list, open, close SSH/RDP/VNC/web connections)',
  'Terminal operations (execute commands, read output, send keystrokes)',
  'Credential management (list, create, read, delete stored credentials)',
  'Web sessions (screenshot, click, type, send keys, scroll, drag, navigate, read content, fill inputs, discover elements, execute JS)',
  'RDP sessions (screenshot, click, type, send keys, mouse move/drag/scroll, resize, get dimensions)',
  'VNC sessions (screenshot, click, type, send keys, mouse move/drag/scroll, get dimensions)',
  'Entry inspection (get entry metadata, read document content — secrets auto-redacted)',
  'Entry & document writing (update entry notes, create/update markdown documents — always ask user approval first)',
];

// ── Shared usage guidelines (used by built-in, CLAUDE.md, and AGENTS.md) ────

const USAGE_GUIDELINES = [
  '## Connection & Session Management',
  '',
  '- **ALWAYS call connection_list FIRST** when the user asks about a connection or session — active connections (status: "connected") already have a usable id. Do NOT browse the vault or ask the user to open a connection if one is already active.',
  '- Each connection in the list has two IDs: `id` (session ID — use with terminal, RDP, VNC, and web tools) and `entry_id` (vault entry ID — use with entry_info, entry_update_notes, document_read, document_update tools).',
  '- **ALWAYS read entry notes first**: Before doing any work on a connection, call `entry_info` with `include_notes: true` using the `entry_id`. Notes serve as a knowledge base — they contain operational context, server configuration, installed services, docker info, runbooks, known issues, and prior work history. Read them before every new session to avoid repeating work or missing context.',
  '- When the user asks to run a command on an SSH session, use terminal_execute with the connection\'s `id`.',
  '- When the user asks about or wants to interact with a web page they have open, use the website_* tools with the active web session\'s `id`.',
  '- Reference the user\'s open sessions by name when relevant.',
  '- If multiple sessions of the same type are open, ask which one the user means if ambiguous.',
  '',
  '### Stale Session ID Recovery',
  '',
  'Session IDs change when connections are closed and reopened. If a tool call fails with "session not found", "not connected", or a similar error:',
  '1. Call connection_list again to get the current session list',
  '2. Find the connection with the same **name** as the one you were using',
  '3. Use its new `id` (and `entry_id`) to continue',
  '4. Do NOT ask the user to reconnect — the session may already be active under a new ID',
  '',
  '## Graphical Interaction (RDP/VNC/Web)',
  '',
  '- Take a screenshot first to see current state before interacting',
  '- Use coordinates from the screenshot to click, type, or interact with elements — coordinates auto-scale from screenshot space',
  '- Take another screenshot after each action to verify the result',
  '- For keyboard shortcuts: use rdp_send_key / vnc_send_key / website_send_key with modifiers (e.g., ["ctrl", "alt"] + "Delete")',
  '- For web sessions: prefer DOM-aware tools (website_click_element, website_fill_input) when you know the CSS selector — they are more reliable than coordinate clicks',
  '- Use website_get_elements to discover interactive elements on a web page',
  '- To run commands on Windows RDP: send_key Win+R, type "cmd", press Enter, then type the command',
  '',
  '## Credentials',
  '',
  '- credential_read requires explicit user approval — always provide a purpose explaining why the credential is needed.',
  '',
  '## Vault Write Tools (entry_update_notes, document_create, document_update)',
  '',
  '- **ALWAYS show the user the exact content you plan to write** before calling the tool',
  '- Wait for the user to approve before proceeding',
  '- These tools modify the encrypted vault — treat writes with the same care as credential operations',
  '- Use document_create to save server documentation, runbooks, docker configs, etc.',
  '- Use entry_update_notes to annotate connections with operational context',
  '',
  '## Knowledge Base — Updating Entry Notes',
  '',
  'Entry notes are a persistent knowledge base for each connection. Keep them current so future sessions start with full context.',
  '',
  '- **Auto-suggest updates**: After completing work on a server — installing software, changing configurations, diagnosing issues, or learning something new about the environment — proactively suggest updating the entry notes to capture what was learned or changed.',
  '- **Merge, never overwrite**: When updating notes, READ the existing notes first via `entry_info`, then incorporate new information into the existing content. Never replace or erase prior notes — add to them, update outdated sections, or append new sections as appropriate.',
  '- **What to capture**: Configuration changes, installed services, discovered environment details (OS, versions, paths), known issues, troubleshooting steps, docker/container layouts, credentials context (not secrets), and anything a future session would benefit from knowing.',
  '- **Always get approval**: Show the user the proposed updated notes (full content) and wait for approval before calling `entry_update_notes`.',
].join('\n');

// ── Tool reference builder ───────────────────────────────────────────────────

interface ToolGroup {
  heading: string;
  tools: { name: string; description: string; requiredParams: string[] }[];
}

const GROUP_PREFIXES: [string, string][] = [
  ['terminal_', 'Terminal'],
  ['local_shell_', 'Local Shell'],
  ['connection_', 'Connection'],
  ['credential_', 'Credential'],
  ['entry_', 'Entry'],
  ['document_', 'Document'],
  ['website_', 'Web Session'],
  ['rdp_', 'RDP'],
  ['vnc_', 'VNC'],
];

function categorize(name: string): string {
  for (const [prefix, heading] of GROUP_PREFIXES) {
    if (name.startsWith(prefix)) return heading;
  }
  return 'Other';
}

/**
 * Generate a categorized tool reference from the TOOL_REGISTRY.
 * Output is concise markdown: `**tool_name** — description (required: param1, param2)`
 */
export function buildToolReference(): string {
  const groups = new Map<string, ToolGroup>();

  for (const tool of TOOL_REGISTRY) {
    const heading = categorize(tool.name);
    if (!groups.has(heading)) {
      groups.set(heading, { heading, tools: [] });
    }
    const params = tool.parameters as { required?: string[] };
    groups.get(heading)!.tools.push({
      name: tool.name,
      description: tool.description,
      requiredParams: params.required ?? [],
    });
  }

  const sections: string[] = [];
  for (const [, group] of groups) {
    const lines = [`### ${group.heading}\n`];
    for (const t of group.tools) {
      const req = t.requiredParams.length > 0
        ? ` (required: ${t.requiredParams.join(', ')})`
        : '';
      lines.push(`- **${t.name}** — ${t.description}${req}`);
    }
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

// ── Composer functions ───────────────────────────────────────────────────────

/**
 * Append text for the Claude Code SDK engine's systemPrompt preset.
 * Injected after the claude_code preset prompt.
 */
export function getClaudeCodeAppend(): string {
  return (
    '\nYou are running inside Conduit, a remote connection manager. ' +
    'You have access to Conduit MCP tools for terminal, RDP, VNC, web, and credential operations.'
  );
}

/**
 * Full content for the external ~/.claude/CLAUDE.md managed section.
 * Includes MCP configuration instructions and a concise tool reference.
 */
export function getExternalClaudeMd(opts: {
  mcpServerPath: string;
  socketPath: string;
  conduitEnv: string;
}): string {
  const toolRef = buildToolReference();

  return [
    `# Conduit MCP Integration`,
    ``,
    `${DESCRIPTION}`,
    ``,
    `Conduit exposes an MCP server that gives you tools to interact with remote connections.`,
    ``,
    `## Setup`,
    ``,
    `Add the Conduit MCP server (if not already configured):`,
    ``,
    '```bash',
    `claude mcp add conduit -- node "${opts.mcpServerPath}" \\`,
    `  --env CONDUIT_SOCKET_PATH="${opts.socketPath}" \\`,
    `  --env CONDUIT_ENV="${opts.conduitEnv}"`,
    '```',
    ``,
    `## Available Tools`,
    ``,
    toolRef,
    ``,
    USAGE_GUIDELINES,
  ].join('\n');
}

/**
 * Full content for the external ~/.codex/AGENTS.md managed section.
 * Includes MCP configuration and a concise tool reference.
 */
export function getExternalAgentsMd(opts: {
  mcpServerPath: string;
  socketPath: string;
  conduitEnv: string;
}): string {
  const toolRef = buildToolReference();

  return [
    `# Conduit MCP Integration`,
    ``,
    `${DESCRIPTION}`,
    ``,
    `Conduit exposes an MCP server that gives you tools to interact with remote connections.`,
    ``,
    `## MCP Configuration`,
    ``,
    `Add this to your MCP config:`,
    ``,
    '```json',
    `{`,
    `  "conduit": {`,
    `    "type": "stdio",`,
    `    "command": "node",`,
    `    "args": ["${opts.mcpServerPath}"],`,
    `    "env": {`,
    `      "CONDUIT_SOCKET_PATH": "${opts.socketPath}",`,
    `      "CONDUIT_ENV": "${opts.conduitEnv}"`,
    `    }`,
    `  }`,
    `}`,
    '```',
    ``,
    `## Available Tools`,
    ``,
    toolRef,
    ``,
    USAGE_GUIDELINES,
  ].join('\n');
}
