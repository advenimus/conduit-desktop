import { AI_HARNESSES, mcpSetupCommand } from "../../lib/ai-harnesses";

export interface McpToolCommand {
  label: string;
  command: (mcpPath: string, socketPath: string) => string;
}

export const MCP_TOOL_COMMANDS: McpToolCommand[] = AI_HARNESSES.map((harness) => ({
  label: harness.name,
  command: (p, s) => mcpSetupCommand(harness.id, p, s),
}));
