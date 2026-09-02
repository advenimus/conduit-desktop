/**
 * CLI harness catalog — launch commands, MCP setup, and metadata for
 * every coding-agent CLI Conduit can host in the agent panel.
 *
 * No Electron imports, so renderer tests can compare IDs.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { EngineType } from './engines/engine.js';

const execFileAsync = promisify(execFile);

export const ENGINE_TYPES: EngineType[] = [
  'claude-code',
  'codex',
  'grok',
  'cursor',
  'openclaw',
  'gemini',
  'copilot',
  'opencode',
];

export interface CliHarness {
  id: EngineType;
  name: string;
  description: string;
  /** Binary shown in UI copy (e.g. "claude", "cursor-agent"). */
  cli: string;
  /** Preferred spawn binary. */
  command: string;
  args: string[];
  installUrl: string;
  loginHintInstalled: string;
  loginHintMissing: string;
  instructionFile: 'CLAUDE.md' | 'AGENTS.md' | 'GEMINI.md';
}

const HARNESSES: Record<EngineType, CliHarness> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    description: "Anthropic's coding agent. Uses your Claude subscription.",
    cli: 'claude',
    command: 'claude',
    args: [],
    installUrl: 'https://code.claude.com/docs/en/setup',
    loginHintInstalled: 'Authenticated via claude login',
    loginHintMissing: "Run 'claude login' in your terminal to authenticate",
    instructionFile: 'CLAUDE.md',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    description: "OpenAI's coding agent. Uses your ChatGPT or API plan.",
    cli: 'codex',
    command: 'codex',
    args: [],
    installUrl: 'https://github.com/openai/codex#installing-and-running-codex-cli',
    loginHintInstalled: 'Authenticated via codex login',
    loginHintMissing: "Run 'codex login' in your terminal to authenticate",
    instructionFile: 'AGENTS.md',
  },
  grok: {
    id: 'grok',
    name: 'Grok Build',
    description: "xAI's coding agent. Uses your Grok / xAI plan.",
    cli: 'grok',
    command: 'grok',
    args: [],
    installUrl: 'https://x.ai/cli',
    loginHintInstalled: 'Authenticated via grok login',
    loginHintMissing: "Run 'grok login' in your terminal to authenticate",
    instructionFile: 'AGENTS.md',
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor Agent',
    description: "Cursor's terminal agent. Uses your Cursor subscription.",
    cli: 'cursor-agent',
    command: 'cursor-agent',
    args: [],
    installUrl: 'https://cursor.com/docs/cli/installation',
    loginHintInstalled: 'Authenticated via cursor-agent login',
    loginHintMissing: "Run 'cursor-agent login' in your terminal to authenticate",
    instructionFile: 'AGENTS.md',
  },
  openclaw: {
    id: 'openclaw',
    name: 'OpenClaw',
    description: "OpenClaw's local TUI agent. Uses your configured providers.",
    cli: 'openclaw',
    command: 'openclaw',
    args: ['tui', '--local'],
    installUrl: 'https://docs.openclaw.ai',
    loginHintInstalled: 'Configured via openclaw onboard',
    loginHintMissing: "Run 'openclaw onboard' in your terminal to set up",
    instructionFile: 'AGENTS.md',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    description: "Google's coding agent. Uses your Gemini / Google plan.",
    cli: 'gemini',
    command: 'gemini',
    args: [],
    installUrl: 'https://geminicli.com',
    loginHintInstalled: 'Authenticated via Gemini CLI sign-in',
    loginHintMissing: "Run 'gemini' and sign in when prompted",
    instructionFile: 'GEMINI.md',
  },
  copilot: {
    id: 'copilot',
    name: 'GitHub Copilot',
    description: "GitHub's terminal coding agent. Uses your Copilot plan.",
    cli: 'copilot',
    command: 'copilot',
    args: [],
    installUrl: 'https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli',
    loginHintInstalled: 'Authenticated via copilot login',
    loginHintMissing: "Run 'copilot login' in your terminal to authenticate",
    instructionFile: 'AGENTS.md',
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    description: "Open-source terminal coding agent. Bring your own provider.",
    cli: 'opencode',
    command: 'opencode',
    args: [],
    installUrl: 'https://opencode.ai/docs',
    loginHintInstalled: 'Configured via opencode auth',
    loginHintMissing: "Run 'opencode auth' in your terminal to add a provider",
    instructionFile: 'AGENTS.md',
  },
};

export function isKnownEngineType(id: string): id is EngineType {
  return (ENGINE_TYPES as string[]).includes(id);
}

export function getHarness(id: EngineType): CliHarness {
  return HARNESSES[id];
}

export function getLaunchSpec(
  id: EngineType,
  cursorBinary = 'cursor-agent',
): { command: string; args: string[] } {
  const harness = HARNESSES[id];
  if (id === 'cursor') {
    return { command: cursorBinary, args: harness.args };
  }
  return { command: harness.command, args: harness.args };
}

export function isCursorVersionBanner(version: string): boolean {
  return /cursor/i.test(version);
}

export function pickCursorBinary(
  candidates: { name: string; exists: boolean; version?: string }[],
): string {
  const cursorAgent = candidates.find((c) => c.name === 'cursor-agent' && c.exists);
  if (cursorAgent) return 'cursor-agent';

  const agent = candidates.find(
    (c) => c.name === 'agent' && c.exists && isCursorVersionBanner(c.version ?? ''),
  );
  if (agent) return 'agent';

  return 'cursor-agent';
}

export function mcpSetupCommand(id: EngineType, mcpPath: string, socketPath: string): string {
  switch (id) {
    case 'claude-code':
      return `claude mcp add --transport stdio --scope project conduit -e CONDUIT_SOCKET_PATH="${socketPath}" -- node "${mcpPath}"`;
    case 'codex':
      return `codex mcp add conduit -e CONDUIT_SOCKET_PATH="${socketPath}" -- node "${mcpPath}"`;
    case 'grok':
      return `grok mcp add --scope project conduit -e CONDUIT_SOCKET_PATH="${socketPath}" -- node "${mcpPath}"`;
    case 'gemini':
      return `gemini mcp add -s project -e CONDUIT_SOCKET_PATH="${socketPath}" conduit node "${mcpPath}"`;
    case 'copilot':
      return `copilot mcp add conduit -e CONDUIT_SOCKET_PATH="${socketPath}" -- node "${mcpPath}"`;
    case 'openclaw':
      return `openclaw mcp add conduit --command node --arg "${mcpPath}" --env CONDUIT_SOCKET_PATH="${socketPath}"`;
    case 'cursor':
      return [
        'Save this as .cursor/mcp.json in your project:',
        JSON.stringify(
          {
            mcpServers: {
              conduit: {
                command: 'node',
                args: [mcpPath],
                env: { CONDUIT_SOCKET_PATH: socketPath },
              },
            },
          },
          null,
          2,
        ),
      ].join('\n');
    case 'opencode':
      return [
        'Add this to opencode.json or .opencode/opencode.json:',
        JSON.stringify(
          {
            mcp: {
              conduit: {
                type: 'local',
                command: ['node', mcpPath],
                environment: { CONDUIT_SOCKET_PATH: socketPath },
              },
            },
          },
          null,
          2,
        ),
      ].join('\n');
  }
}

export interface ProjectMcpFile {
  relativePath: string;
  contents: string;
}

function stdioMcpServer(mcpPath: string, socketPath: string, conduitEnv: string) {
  return {
    type: 'stdio',
    command: 'node',
    args: [mcpPath],
    env: {
      CONDUIT_SOCKET_PATH: socketPath,
      CONDUIT_ENV: conduitEnv,
      CONDUIT_INTERNAL_AGENT: '1',
    },
  };
}

export function projectMcpConfigFiles(
  id: EngineType,
  mcpPath: string,
  socketPath: string,
  conduitEnv: string,
): ProjectMcpFile[] {
  const server = stdioMcpServer(mcpPath, socketPath, conduitEnv);
  const files: ProjectMcpFile[] = [
    {
      relativePath: '.mcp.json',
      contents: JSON.stringify({ mcpServers: { conduit: server } }, null, 2) + '\n',
    },
  ];

  if (id === 'cursor') {
    files.push({
      relativePath: '.cursor/mcp.json',
      contents:
        JSON.stringify(
          {
            mcpServers: {
              conduit: {
                command: server.command,
                args: server.args,
                env: server.env,
              },
            },
          },
          null,
          2,
        ) + '\n',
    });
  }

  return files;
}

export async function binaryVersion(bin: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['--version'], { timeout: 5000 });
    const text = `${stdout}${stderr}`.trim();
    return text.length > 0 ? text : 'ok';
  } catch {
    return null;
  }
}

export async function resolveCursorBinary(): Promise<string> {
  const cursorAgent = await binaryVersion('cursor-agent');
  const agent = await binaryVersion('agent');
  return pickCursorBinary([
    { name: 'cursor-agent', exists: cursorAgent !== null, version: cursorAgent ?? undefined },
    { name: 'agent', exists: agent !== null, version: agent ?? undefined },
  ]);
}

export async function resolveLaunchCommand(
  id: EngineType,
): Promise<{ command: string; args: string[] }> {
  if (id === 'cursor') {
    const bin = await resolveCursorBinary();
    return getLaunchSpec(id, bin);
  }
  return getLaunchSpec(id);
}

export async function checkHarnessAvailable(id: EngineType): Promise<boolean> {
  if (id === 'cursor') {
    const bin = await resolveCursorBinary();
    return (await binaryVersion(bin)) !== null;
  }
  const { command } = getLaunchSpec(id);
  return (await binaryVersion(command)) !== null;
}

export async function checkAllHarnessesAvailable(): Promise<Record<EngineType, boolean>> {
  const entries = await Promise.all(
    ENGINE_TYPES.map(async (id) => [id, await checkHarnessAvailable(id)] as const),
  );
  return Object.fromEntries(entries) as Record<EngineType, boolean>;
}

export function writeProjectMcpFiles(
  agentDir: string,
  id: EngineType,
  mcpPath: string,
  socketPath: string,
  conduitEnv: string,
): void {
  for (const file of projectMcpConfigFiles(id, mcpPath, socketPath, conduitEnv)) {
    const fullPath = path.join(agentDir, file.relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
    if (existing.trim() !== file.contents.trim()) {
      fs.writeFileSync(fullPath, file.contents, 'utf-8');
    }
  }
}
