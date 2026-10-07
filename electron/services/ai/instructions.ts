/**
 * Centralized AI instruction text — single source of truth for all prompt variants.
 *
 * Used by:
 * - Claude Code engine append (claude-code-engine.ts)
 * - CLI agent instruction files written into Conduit's own agent working
 *   directories ({dataDir}/agent/{engine}/CLAUDE.md, AGENTS.md, or GEMINI.md)
 */

import { TOOL_REGISTRY } from './tool-registry.js';

// ── Reusable instruction sections ────────────────────────────────────────────

const DESCRIPTION =
  'Conduit is a cross-platform remote connection manager with AI integration. ' +
  'It manages SSH, RDP, VNC, and web connections with an encrypted credential vault.';

// ── Shared usage guidelines (used by built-in, CLAUDE.md, and AGENTS.md) ────

const USAGE_GUIDELINES = [
  '## Connection & Session Management',
  '',
  '- **ALWAYS call connection_list FIRST** when the user asks about a connection or session — active connections (status: "connected") already have a usable id. Do NOT browse the vault or ask the user to open a connection if one is already active.',
  '- Each connection in the list has two IDs: `id` (session ID — use with terminal, RDP, VNC, and web tools) and `entry_id` (vault entry ID — use with entry_info, entry_update_notes, entry_edit_notes, document_read, document_update tools).',
  '- **ALWAYS read what Conduit knows first**: Before doing any work on a connection, call `entry_info` with `include_notes: true` using the `entry_id`. Its `knowledge` block lists the knowledge articles that apply (the asset\'s own, its folders\', matching vault playbooks); read the relevant ones with `kb_read`. Together with the notes they hold configuration, runbooks, known issues and prior work. Read them before every new session to avoid repeating work or missing context.',
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
  '### Other Agents',
  '',
  'Other AI agents may be working in Conduit at the same time as you. Each active session in connection_list has an `owner`:',
  '- `you`: you opened it or already worked in it. Keep using it.',
  '- `free`: no agent is working in it (for example a session the user opened). You may use it.',
  '- `other_agent`: another agent is working in it. Do not type, click, or run commands there. Reading it (terminal_read_pane, screenshots) is fine.',
  '',
  'When the session you need belongs to another agent:',
  '- SSH: open your own with connection_open_entry using the same `entry_id`. Local shell: use local_shell_create.',
  '- RDP, VNC, or web: do not open a second one, since another login can disconnect the first. Tell the user the session is busy and ask what to do.',
  '- A tool that fails with `SESSION_IN_USE` means the same thing. Follow its message instead of retrying.',
  '',
  '## Terminal Commands',
  '',
  '- terminal_execute runs a command or a whole multi-line script (heredocs, loops, quotes) exactly as written and returns its exit code and output. Prefer one well-formed script over many tiny calls.',
  '- Keep commands non-interactive: use `--no-pager`, `| cat`, `-y`/`--yes`, and `DEBIAN_FRONTEND=noninteractive`. Pagers and prompts make the command wait until it times out.',
  '- For password prompts, REPLs, installers, or full-screen programs, use terminal_send_keys with `wait_ms` to type and see the response, and terminal_read_pane to view the screen.',
  '- If a command times out it keeps running and the session reports busy. Check it with terminal_read_pane, then wait, answer it, or interrupt it by sending `\\x03`.',
  '- For SSH sessions to Windows PowerShell hosts, pass `shell: "powershell"` to terminal_execute.',
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
  '## Credentials and Secrets',
  '',
  '- You never need to see a password to use it. Secrets appear as refs: `{{secret:<id>|Label}}` in notes and knowledge articles, and `password_ref` / `totp_ref` from credential_read.',
  '- Put a ref straight into terminal_execute, terminal_send_keys, rdp_type, vnc_type, website_type, website_fill_input or connection_open. Conduit types the real value; output you read back shows the ref again.',
  '- Never paste a plain password into a command, note or article. Never put refs in website_execute_js (it is refused).',
  '- To make a new password, use secret_create with `generate` so the value is created in Conduit and never passes through you. To change one, use secret_rotate, apply `{{secret:<id>.pending}}` on the system, then secret_commit.',
  '- credential_read with `reveal: true` (or secret_reveal) asks the user to Allow or Deny showing a plain value. Use it only when the value itself must be shown to the user, and give a clear purpose.',
  '',
  '## Vault Write Tools (entry_edit_notes, entry_update_notes, document_create, document_update)',
  '',
  '- **ALWAYS show the user the exact content you plan to write** before calling these tools, and wait for approval',
  '- Use entry_edit_notes to change part of an entry\'s notes (a line, a section) with exact find-and-replace edits; use entry_update_notes only to rewrite the whole thing',
  '- **Secrets**: encrypted secrets show as `{{secret:<id>|Label}}` refs; keep or copy them as they are. Older unencrypted secrets show as `[SECRET_n]` tokens; leave a token in place to keep that secret. Never write `[REDACTED]` or guess a secret. Any `!!value!!` you write is encrypted on save, but prefer secret_create.',
  '',
  '## Knowledge Base',
  '',
  'Each asset, folder and the vault has knowledge articles: a shared memory that you and other agents build up over time. It is the place to learn from before working and to write to while working.',
  '',
  '- **Read before you work**: use the `knowledge` block from entry_info, kb_context, or kb_search (to see how a problem was solved elsewhere). Check articles marked `stale` against the system and call kb_verify.',
  '- **Write as you learn, without asking first**: kb_write saves at once and the user reviews and can undo agent edits in Conduit. Record discoveries (OS, versions, roles, paths, layouts), procedures that worked, and problems with their cause and fix. Update the existing article on a topic rather than adding a near duplicate, and give a short `reason`.',
  '- **Pick the right home**: `asset` for one machine; `folder` for things every asset in a folder shares (a client\'s network, VPN, vendor contacts); `vault` playbooks for routines across many assets (tag them so they reach the right assets).',
  '- **Pick the right kind**: overview (what it is and what matters; one per asset), facts, procedure, troubleshooting, contact, playbook.',
  '- **Log every change** you make on a system with kb_log: installs, config edits, restarts, rotations. One sentence each.',
  '- **Never put a plain password in an article**: keep refs, or create a secret with secret_create and write its ref.',
  '- **Old notes**: when entry_info reports `migration_suggested`, offer once to move the notes into articles. If the user agrees, split them by topic and call kb_import_notes (keep tokens and refs exactly); if not, call kb_dismiss_migration. Never delete notes on your own.',
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
  ['kb_', 'Knowledge Base'],
  ['secret_', 'Secrets'],
  ['command_', 'Command'],
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
 * Full content for the CLAUDE.md managed section written into the Claude Code
 * agent working directory. Includes MCP setup and a concise tool reference.
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
    // The server is already registered via the .mcp.json Conduit writes beside
    // this file — the command is only a fallback if that config is rejected.
    `The Conduit MCP server is already registered for this directory in \`.mcp.json\`. If it is unavailable, re-add it:`,
    ``,
    '```bash',
    `claude mcp add conduit \\`,
    `  --env CONDUIT_SOCKET_PATH="${opts.socketPath}" \\`,
    `  --env CONDUIT_ENV="${opts.conduitEnv}" \\`,
    `  -- node "${opts.mcpServerPath}"`,
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
 * Full content for the AGENTS.md managed section written into the Codex agent
 * working directory. Includes MCP configuration and a concise tool reference.
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
    `The Conduit MCP server is already registered for this directory in \`.mcp.json\`. If it is unavailable, add this to your MCP config:`,
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
