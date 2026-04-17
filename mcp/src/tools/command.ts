/**
 * Command execution MCP tool.
 *
 * Executes a configured command entry and returns the output.
 */

import type { ConduitClient } from '../ipc-client.js';

// ---------- Tool definitions ----------

export function commandExecuteDefinition() {
  return {
    name: 'command_execute',
    description:
      'Execute a command entry from the vault. The entry must be of type "command" with a configured command, optional credentials, and execution settings. Returns the command output and exit code.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: {
          type: 'string',
          description: 'UUID of the command entry in the vault',
        },
        timeout_ms: {
          type: 'number',
          description: 'Maximum time to wait for completion in milliseconds (default: 300000 = 5 minutes)',
          default: 300000,
        },
      },
      required: ['entry_id'],
    },
  };
}

// ---------- Tool handlers ----------

export async function commandExecute(
  client: ConduitClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const entryId = args.entry_id as string;
  const timeoutMs = (args.timeout_ms as number) ?? 300000;

  if (!entryId) {
    throw new Error('entry_id is required');
  }

  return client.commandExecute(entryId, timeoutMs);
}
