export interface McpToolCommand {
  label: string;
  command: (mcpPath: string, socketPath: string) => string;
}

export const MCP_TOOL_COMMANDS: McpToolCommand[] = [
  {
    label: "Claude Code",
    command: (p, s) =>
      `claude mcp add --transport stdio --scope project conduit -e CONDUIT_SOCKET_PATH="${s}" -- node "${p}"`,
  },
  {
    label: "Codex",
    command: (p, s) =>
      `codex mcp add conduit -e CONDUIT_SOCKET_PATH="${s}" -- node "${p}"`,
  },
];
