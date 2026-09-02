export type EngineType =
  | "claude-code"
  | "codex"
  | "grok"
  | "cursor"
  | "openclaw"
  | "gemini"
  | "copilot"
  | "opencode";

export const ENGINE_TYPES: EngineType[] = [
  "claude-code",
  "codex",
  "grok",
  "cursor",
  "openclaw",
  "gemini",
  "copilot",
  "opencode",
];

export interface AiHarnessInfo {
  id: EngineType;
  name: string;
  description: string;
  cli: string;
  loginHintInstalled: string;
  loginHintMissing: string;
}

const HARNESSES: Record<EngineType, AiHarnessInfo> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic's coding agent. Uses your Claude subscription.",
    cli: "claude",
    loginHintInstalled: "Authenticated via claude login",
    loginHintMissing: "Run 'claude login' in your terminal to authenticate",
  },
  codex: {
    id: "codex",
    name: "Codex",
    description: "OpenAI's coding agent. Uses your ChatGPT or API plan.",
    cli: "codex",
    loginHintInstalled: "Authenticated via codex login",
    loginHintMissing: "Run 'codex login' in your terminal to authenticate",
  },
  grok: {
    id: "grok",
    name: "Grok Build",
    description: "xAI's coding agent. Uses your Grok / xAI plan.",
    cli: "grok",
    loginHintInstalled: "Authenticated via grok login",
    loginHintMissing: "Run 'grok login' in your terminal to authenticate",
  },
  cursor: {
    id: "cursor",
    name: "Cursor Agent",
    description: "Cursor's terminal agent. Uses your Cursor subscription.",
    cli: "cursor-agent",
    loginHintInstalled: "Authenticated via cursor-agent login",
    loginHintMissing: "Run 'cursor-agent login' in your terminal to authenticate",
  },
  openclaw: {
    id: "openclaw",
    name: "OpenClaw",
    description: "OpenClaw's local TUI agent. Uses your configured providers.",
    cli: "openclaw",
    loginHintInstalled: "Configured via openclaw onboard",
    loginHintMissing: "Run 'openclaw onboard' in your terminal to set up",
  },
  gemini: {
    id: "gemini",
    name: "Gemini CLI",
    description: "Google's coding agent. Uses your Gemini / Google plan.",
    cli: "gemini",
    loginHintInstalled: "Authenticated via Gemini CLI sign-in",
    loginHintMissing: "Run 'gemini' and sign in when prompted",
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot",
    description: "GitHub's terminal coding agent. Uses your Copilot plan.",
    cli: "copilot",
    loginHintInstalled: "Authenticated via copilot login",
    loginHintMissing: "Run 'copilot login' in your terminal to authenticate",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    description: "Open-source terminal coding agent. Bring your own provider.",
    cli: "opencode",
    loginHintInstalled: "Configured via opencode auth",
    loginHintMissing: "Run 'opencode auth' in your terminal to add a provider",
  },
};

export const AI_HARNESSES: AiHarnessInfo[] = ENGINE_TYPES.map((id) => HARNESSES[id]);

export function isEngineType(id: string): id is EngineType {
  return (ENGINE_TYPES as string[]).includes(id);
}

export function getHarness(id: EngineType): AiHarnessInfo {
  return HARNESSES[id];
}

export function mcpSetupCommand(id: EngineType, mcpPath: string, socketPath: string): string {
  switch (id) {
    case "claude-code":
      return `claude mcp add --transport stdio --scope project conduit -e CONDUIT_SOCKET_PATH="${socketPath}" -- node "${mcpPath}"`;
    case "codex":
      return `codex mcp add conduit -e CONDUIT_SOCKET_PATH="${socketPath}" -- node "${mcpPath}"`;
    case "grok":
      return `grok mcp add --scope project conduit -e CONDUIT_SOCKET_PATH="${socketPath}" -- node "${mcpPath}"`;
    case "gemini":
      return `gemini mcp add -s project -e CONDUIT_SOCKET_PATH="${socketPath}" conduit node "${mcpPath}"`;
    case "copilot":
      return `copilot mcp add conduit -e CONDUIT_SOCKET_PATH="${socketPath}" -- node "${mcpPath}"`;
    case "openclaw":
      return `openclaw mcp add conduit --command node --arg "${mcpPath}" --env CONDUIT_SOCKET_PATH="${socketPath}"`;
    case "cursor":
      return [
        "Save this as .cursor/mcp.json in your project:",
        JSON.stringify(
          {
            mcpServers: {
              conduit: {
                command: "node",
                args: [mcpPath],
                env: { CONDUIT_SOCKET_PATH: socketPath },
              },
            },
          },
          null,
          2,
        ),
      ].join("\n");
    case "opencode":
      return [
        "Add this to opencode.json or .opencode/opencode.json:",
        JSON.stringify(
          {
            mcp: {
              conduit: {
                type: "local",
                command: ["node", mcpPath],
                environment: { CONDUIT_SOCKET_PATH: socketPath },
              },
            },
          },
          null,
          2,
        ),
      ].join("\n");
  }
}
