// A stdio MCP client for one device: spawns mcp/dist/index.js against that device's socket.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO } from './run-context.mjs';
import { redact } from './redact.mjs';
import { withTimeout } from './ui.mjs';

const mcpRequire = createRequire(path.join(REPO, 'mcp', 'package.json'));

const CALL_TIMEOUT_MS = 60_000;

export class McpToolError extends Error {
  constructor(tool, text) {
    super(`MCP tool ${tool} returned an error: ${text.slice(0, 500)}`);
    this.name = 'McpToolError';
    this.tool = tool;
    this.text = text;
  }
}

function resultText(result) {
  return (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Connects an MCP client to `device` (it must be running). The server runs from the device's
 * launcher/mcp link, so no Conduit build's stale-MCP reaper matches it.
 * Returns {listTools, callTool, callToolRaw, close}.
 */
export async function connectMcp(device, { clientName = 'conduit-verify' } = {}) {
  const entry = path.join(device.root, 'launcher', 'mcp', 'dist', 'index.js');
  if (!fs.existsSync(entry)) throw new Error(`MCP server not built: ${entry} is missing (run buildForRun first)`);
  const { Client } = mcpRequire('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = mcpRequire('@modelcontextprotocol/sdk/client/stdio.js');
  const logFile = device.run.logPath(`${device.name}.mcp.log`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: device.root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: device.home,
      CONDUIT_ENV: 'preview',
      CONDUIT_SOCKET_PATH: device.socketPath,
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => fs.appendFileSync(logFile, redact(chunk.toString())));
  // The app names agents after the MCP client, so promo footage can show "claude-code" as Claude Code.
  const client = new Client({ name: clientName, version: '1.0.0' });
  await withTimeout(client.connect(transport), 30_000, `${device.name}: MCP connect`);
  const unregister = device.run.onCleanup(`close MCP client for ${device.name}`, () => client.close());

  async function callToolRaw(name, args = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
    const result = await withTimeout(client.callTool({ name, arguments: args }), timeoutMs, `${device.name}: MCP ${name}`);
    const text = resultText(result);
    fs.appendFileSync(logFile, `${redact(`[call] ${name} -> ${result.isError ? 'error' : 'ok'}: ${text.slice(0, 400)}`)}\n`);
    return { isError: result.isError === true, text, data: parse(text), result };
  }

  return {
    client,
    async listTools() {
      const { tools } = await withTimeout(client.listTools(), 30_000, `${device.name}: MCP listTools`);
      return tools;
    },
    callToolRaw,
    /** Parsed JSON of the tool's text content (or the text). Throws McpToolError when isError. */
    async callTool(name, args, opts) {
      const res = await callToolRaw(name, args, opts);
      if (res.isError) throw new McpToolError(name, res.text);
      return res.data;
    },
    close: unregister,
  };
}
