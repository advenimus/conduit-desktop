#!/usr/bin/env node
/**
 * Conduit MCP Server - main entry point.
 *
 * Port of crates/conduit-mcp/src/bin/main.rs + crates/conduit-mcp/src/server.rs
 *
 * MCP server with stdio transport using @modelcontextprotocol/sdk.
 * Connects to the main Conduit Electron app via Unix socket IPC.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { ConduitClient, type TierInfo } from './ipc-client.js';
import { RateLimitManager, defaultRateLimits } from './rate-limiter.js';
import { DailyQuotaManager } from './daily-quota.js';
import { AuditLogger } from './audit.js';
import { TOOL_CATEGORIES } from './tool-categories.js';
import { track } from './analytics.js';

// Terminal tools
import {
  terminalExecuteDefinition, terminalExecute,
  terminalReadPaneDefinition, terminalReadPane,
  terminalSendKeysDefinition, terminalSendKeys,
  localShellCreateDefinition, localShellCreate,
} from './tools/terminal.js';

// RDP tools
import {
  rdpScreenshotDefinition, rdpScreenshot,
  rdpClickDefinition, rdpClick,
  rdpTypeDefinition, rdpType,
  rdpSendKeyDefinition, rdpSendKey,
  rdpMouseMoveDefinition, rdpMouseMove,
  rdpMouseDragDefinition, rdpMouseDrag,
  rdpMouseScrollDefinition, rdpMouseScroll,
  rdpResizeDefinition, rdpResize,
  rdpGetDimensionsDefinition, rdpGetDimensions,
} from './tools/rdp.js';

// VNC tools
import {
  vncScreenshotDefinition, vncScreenshot,
  vncClickDefinition, vncClick,
  vncTypeDefinition, vncType,
  vncSendKeyDefinition, vncSendKey,
  vncMouseMoveDefinition, vncMouseMove,
  vncMouseScrollDefinition, vncMouseScroll,
  vncMouseDragDefinition, vncMouseDrag,
  vncGetDimensionsDefinition, vncGetDimensions,
} from './tools/vnc.js';

// Web tools
import {
  websiteScreenshotDefinition, websiteScreenshot,
  websiteReadContentDefinition, websiteReadContent,
  websiteNavigateDefinition, websiteNavigate,
  websiteClickDefinition, websiteClick,
  websiteTypeDefinition, websiteType,
  websiteSendKeyDefinition, websiteSendKey,
  websiteMouseMoveDefinition, websiteMouseMove,
  websiteMouseDragDefinition, websiteMouseDrag,
  websiteMouseScrollDefinition, websiteMouseScroll,
  websiteGetDimensionsDefinition, websiteGetDimensions,
  websiteClickElementDefinition, websiteClickElement,
  websiteFillInputDefinition, websiteFillInput,
  websiteGetElementsDefinition, websiteGetElements,
  websiteExecuteJsDefinition, websiteExecuteJs,
  websiteListTabsDefinition, websiteListTabs,
  websiteCreateTabDefinition, websiteCreateTab,
  websiteCloseTabDefinition, websiteCloseTab,
  websiteSwitchTabDefinition, websiteSwitchTab,
  websiteGoBackDefinition, websiteGoBack,
  websiteGoForwardDefinition, websiteGoForward,
  websiteReloadDefinition, websiteReload,
} from './tools/web.js';

// Credential tools
import {
  credentialListDefinition, credentialList,
  credentialCreateDefinition, credentialCreate,
  credentialReadDefinition, credentialRead,
  credentialDeleteDefinition, credentialDelete,
} from './tools/credential.js';

// Connection tools
import {
  connectionListDefinition, connectionList,
  connectionOpenDefinition, connectionOpen,
  connectionCloseDefinition, connectionClose,
} from './tools/connection.js';

// Command tools
import {
  commandExecuteDefinition, commandExecute,
} from './tools/command.js';

// Entry tools
import {
  entryInfoDefinition, entryInfo,
  documentReadDefinition, documentRead,
  entryUpdateNotesDefinition, entryUpdateNotes,
  documentCreateDefinition, documentCreate,
  documentUpdateDefinition, documentUpdate,
} from './tools/entry.js';

const VERSION = '0.1.0';

// ---------- CLI argument handling ----------

function printHelp(): void {
  process.stderr.write(`Conduit MCP Server

An MCP server for the Conduit remote connection manager.

USAGE:
    conduit-mcp [OPTIONS]

OPTIONS:
    --version    Print version information
    --help       Print this help message

The server uses stdio transport and communicates with the main Conduit
application via IPC.

For Claude Code integration:
    claude config add mcp conduit --command "node /path/to/mcp/dist/index.js"
`);
}

function printVersion(): void {
  process.stderr.write(`conduit-mcp ${VERSION}\n`);
}

// ---------- Tool registry ----------

type ToolHandler = (client: ConduitClient, args: Record<string, unknown>) => Promise<unknown>;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

function buildToolRegistry(): Map<string, ToolEntry> {
  const registry = new Map<string, ToolEntry>();

  function add(def: ToolDefinition, handler: ToolHandler) {
    registry.set(def.name, { definition: def, handler });
  }

  // Terminal
  add(terminalExecuteDefinition(), terminalExecute as ToolHandler);
  add(terminalReadPaneDefinition(), terminalReadPane as ToolHandler);
  add(terminalSendKeysDefinition(), terminalSendKeys as ToolHandler);
  add(localShellCreateDefinition(), localShellCreate as ToolHandler);

  // RDP
  add(rdpScreenshotDefinition(), rdpScreenshot as ToolHandler);
  add(rdpClickDefinition(), rdpClick as ToolHandler);
  add(rdpTypeDefinition(), rdpType as ToolHandler);
  add(rdpSendKeyDefinition(), rdpSendKey as ToolHandler);
  add(rdpMouseMoveDefinition(), rdpMouseMove as ToolHandler);
  add(rdpMouseDragDefinition(), rdpMouseDrag as ToolHandler);
  add(rdpMouseScrollDefinition(), rdpMouseScroll as ToolHandler);
  add(rdpResizeDefinition(), rdpResize as ToolHandler);
  add(rdpGetDimensionsDefinition(), rdpGetDimensions as ToolHandler);

  // VNC
  add(vncScreenshotDefinition(), vncScreenshot as ToolHandler);
  add(vncClickDefinition(), vncClick as ToolHandler);
  add(vncTypeDefinition(), vncType as ToolHandler);
  add(vncSendKeyDefinition(), vncSendKey as ToolHandler);
  add(vncMouseMoveDefinition(), vncMouseMove as ToolHandler);
  add(vncMouseScrollDefinition(), vncMouseScroll as ToolHandler);
  add(vncMouseDragDefinition(), vncMouseDrag as ToolHandler);
  add(vncGetDimensionsDefinition(), vncGetDimensions as ToolHandler);

  // Web
  add(websiteScreenshotDefinition(), websiteScreenshot as ToolHandler);
  add(websiteReadContentDefinition(), websiteReadContent as ToolHandler);
  add(websiteNavigateDefinition(), websiteNavigate as ToolHandler);
  add(websiteClickDefinition(), websiteClick as ToolHandler);
  add(websiteTypeDefinition(), websiteType as ToolHandler);
  add(websiteSendKeyDefinition(), websiteSendKey as ToolHandler);
  add(websiteMouseMoveDefinition(), websiteMouseMove as ToolHandler);
  add(websiteMouseDragDefinition(), websiteMouseDrag as ToolHandler);
  add(websiteMouseScrollDefinition(), websiteMouseScroll as ToolHandler);
  add(websiteGetDimensionsDefinition(), websiteGetDimensions as ToolHandler);
  add(websiteClickElementDefinition(), websiteClickElement as ToolHandler);
  add(websiteFillInputDefinition(), websiteFillInput as ToolHandler);
  add(websiteGetElementsDefinition(), websiteGetElements as ToolHandler);
  add(websiteExecuteJsDefinition(), websiteExecuteJs as ToolHandler);
  add(websiteListTabsDefinition(), websiteListTabs as ToolHandler);
  add(websiteCreateTabDefinition(), websiteCreateTab as ToolHandler);
  add(websiteCloseTabDefinition(), websiteCloseTab as ToolHandler);
  add(websiteSwitchTabDefinition(), websiteSwitchTab as ToolHandler);
  add(websiteGoBackDefinition(), websiteGoBack as ToolHandler);
  add(websiteGoForwardDefinition(), websiteGoForward as ToolHandler);
  add(websiteReloadDefinition(), websiteReload as ToolHandler);

  // Credentials
  add(credentialListDefinition(), (client) => credentialList(client));
  add(credentialCreateDefinition(), credentialCreate as ToolHandler);
  add(credentialReadDefinition(), ((client: ConduitClient, args: Record<string, unknown>) =>
    credentialRead(client, args as { credential_id: string; purpose: string }, true)) as ToolHandler);
  add(credentialDeleteDefinition(), credentialDelete as ToolHandler);

  // Connections
  add(connectionListDefinition(), (client) => connectionList(client));
  add(connectionOpenDefinition(), connectionOpen as ToolHandler);
  add(connectionCloseDefinition(), connectionClose as ToolHandler);

  // Command
  add(commandExecuteDefinition(), commandExecute as ToolHandler);

  // Entry
  add(entryInfoDefinition(), entryInfo as ToolHandler);
  add(entryUpdateNotesDefinition(), entryUpdateNotes as ToolHandler);
  add(documentReadDefinition(), documentRead as ToolHandler);
  add(documentCreateDefinition(), documentCreate as ToolHandler);
  add(documentUpdateDefinition(), documentUpdate as ToolHandler);

  return registry;
}

// ---------- Main ----------

async function main(): Promise<void> {
  // Handle CLI args
  const args = process.argv.slice(2);
  for (const arg of args) {
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      case '--version':
      case '-V':
        printVersion();
        process.exit(0);
        break;
      default:
        process.stderr.write(`Unknown argument: ${arg}\n`);
        printHelp();
        process.exit(1);
    }
  }

  process.stderr.write(`Starting Conduit MCP server v${VERSION}\n`);

  const requireApproval = process.env.CONDUIT_INTERNAL_AGENT === '1';

  // Initialize audit logger
  const auditLogger = AuditLogger.create();

  // Initialize rate limiter
  const rateLimiter = new RateLimitManager(defaultRateLimits());

  // Try to connect to Conduit app
  let client: ConduitClient | null = null;
  try {
    client = await ConduitClient.connect();
    process.stderr.write('Connected to Conduit app\n');
  } catch (e) {
    process.stderr.write(
      `Failed to connect to Conduit app: ${e}. Running in standalone mode.\n`,
    );
  }

  const dailyQuota = new DailyQuotaManager();

  // Cached tier info (refetched periodically from the main app)
  let cachedTier: TierInfo | null = null;
  let tierFetchedAt = 0;
  const TIER_CACHE_MS = 60_000; // 1 minute

  async function getTier(): Promise<TierInfo> {
    const now = Date.now();
    if (cachedTier && now - tierFetchedAt < TIER_CACHE_MS) {
      return cachedTier;
    }
    if (!client) {
      return { tier_name: 'free', mcp_daily_quota: 50, authenticated: false };
    }
    try {
      cachedTier = await client.getTierInfo();
      tierFetchedAt = now;
      return cachedTier;
    } catch (err) {
      process.stderr.write(`[mcp] getTierInfo failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return cachedTier ?? { tier_name: 'free', mcp_daily_quota: 50, authenticated: false };
    }
  }

  // Build tool registry
  const toolRegistry = buildToolRegistry();

  // Create MCP server
  const server = new Server(
    {
      name: 'conduit',
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Handle list tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = Array.from(toolRegistry.values()).map((entry) => entry.definition);
    return { tools };
  });

  // Handle call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const toolArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

    const entry = toolRegistry.get(toolName);
    if (!entry) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }],
        isError: true,
      };
    }

    // Check daily quota (Free tier = 50/day, Pro/Team = unlimited).
    const tier = await getTier();
    const quotaResult = dailyQuota.check(tier.mcp_daily_quota);
    if (!quotaResult.allowed) {
      auditLogger.logRateLimited(toolName, 'mcp-client', toolArgs);
      track('mcp.quota_hit', { tier: tier.tier_name, quota: tier.mcp_daily_quota });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Daily MCP quota exceeded',
              reason: `You have used your daily MCP quota of ${tier.mcp_daily_quota} tool calls. `
                + 'Upgrade to Pro for unlimited MCP tool calls.',
              quota: tier.mcp_daily_quota,
              used: quotaResult.count,
              resetAt: quotaResult.resetAt,
              upgradeUrl: 'https://conduitdesktop.com/pricing',
            }),
          },
        ],
        isError: true,
      };
    }

    // Check per-minute rate limit
    if (!rateLimiter.check(toolName)) {
      auditLogger.logRateLimited(toolName, 'mcp-client', toolArgs);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `Rate limit exceeded for tool: ${toolName}` }),
          },
        ],
        isError: true,
      };
    }

    // Check that we have a client connection
    if (!client) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Not connected to Conduit app',
              reason: 'Conduit MCP tools require an active connection to the Conduit desktop app. '
                + 'Please make sure the Conduit app is running and your vault is unlocked.',
            }),
          },
        ],
        isError: true,
      };
    }

    const start = Date.now();
    const argsSummary = Object.keys(toolArgs).length > 0
      ? ` ${JSON.stringify(toolArgs)}`
      : '';
    process.stderr.write(`[mcp] Tool call: ${toolName}${argsSummary}\n`);

    // Request user approval only when running as Conduit's internal agent
    if (requireApproval) {
      try {
        const category = TOOL_CATEGORIES[toolName] ?? 'execute';
        const approved = await client.requestToolApproval(
          toolName,
          entry.definition.description,
          category,
          toolArgs,
        );
        if (!approved) {
          process.stderr.write(`[mcp] Tool ${toolName} DENIED by user\n`);
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Tool call denied by user: ${toolName}` }) }],
            isError: true,
          };
        }
      } catch (approvalErr) {
        const errMsg = approvalErr instanceof Error ? approvalErr.message : String(approvalErr);
        process.stderr.write(`[mcp] Tool ${toolName} approval error: ${errMsg}\n`);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Tool approval failed: ${errMsg}` }) }],
          isError: true,
        };
      }
    }

    try {
      const result = await entry.handler(client, toolArgs);
      const durationMs = Date.now() - start;
      auditLogger.logSuccess(toolName, 'mcp-client', toolArgs, durationMs);
      process.stderr.write(`[mcp] Tool ${toolName} completed (${durationMs}ms)\n`);

      // Record quota usage on success. Failures don't count against the quota.
      dailyQuota.record();

      // Fire mcp.first_call on the first successful tool call this session.
      // Session-scoped rather than persistent — a per-install "first tool call
      // ever" counter would require extra state tracking and isn't worth it.
      if (quotaResult.count === 0) {
        track('mcp.first_call', { tier: tier.tier_name, tool: toolName });
      }

      // If result contains a base64 image, return it as a native MCP image content block.
      // This lets Claude process the image via vision (~1-2K tokens) instead of tokenizing
      // the entire base64 string as text (~15-500K tokens per screenshot).
      if (result && typeof result === 'object' && 'image' in result) {
        const { image, format, ...metadata } = result as Record<string, unknown>;
        const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
        const content: Array<{ type: string; [key: string]: unknown }> = [
          { type: 'image', data: image as string, mimeType },
        ];
        if (Object.keys(metadata).length > 0) {
          content.push({ type: 'text', text: JSON.stringify(metadata, null, 2) });
        }
        return { content };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      const durationMs = Date.now() - start;
      const errMsg = e instanceof Error ? e.message : String(e);
      auditLogger.logError(toolName, 'mcp-client', toolArgs, errMsg, durationMs);
      process.stderr.write(`[mcp] Tool ${toolName} ERROR (${durationMs}ms): ${errMsg}\n`);

      return {
        content: [{ type: 'text', text: JSON.stringify({ error: errMsg }) }],
        isError: true,
      };
    }
  });

  process.stderr.write('MCP server ready, waiting for requests...\n');

  // Run with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`Fatal error: ${e}\n`);
  process.exit(1);
});
