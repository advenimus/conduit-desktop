/**
 * Claude Code Engine — wraps the @anthropic-ai/claude-agent-sdk
 *
 * Uses the `query()` async generator to stream structured messages
 * and converts them to ChatEngineEvents.
 *
 * Persistent subprocess: The first message in a session spawns a subprocess
 * via query() with an AsyncIterable prompt. Subsequent messages push into
 * the same iterable, reusing the warm subprocess (no re-spawn, no MCP
 * reconnect). The subprocess stays alive until the session is destroyed.
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import type {
  ChatEngine,
  ChatEngineEvent,
  ChatEngineSession,
  CreateSessionOptions,
  EngineModelInfo,
  EngineType,
} from './engine.js';
import type { EngineManager } from './engine-manager.js';
import { getSocketPath, getEnvConfig } from '../../env-config.js';
import { getClaudeCodeAppend } from '../instructions.js';

// ── SDK type stubs ──────────────────────────────────────────────────────────
// We import the SDK dynamically so the app still loads if it isn't installed.

interface SdkSpawnOptions {
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

interface SdkUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

interface SdkQueryOptions {
  prompt: string | AsyncIterable<SdkUserMessage>;
  options?: {
    abortController?: AbortController;
    cwd?: string;
    model?: string;
    mcpServers?: Record<string, unknown>;
    resume?: string;
    permissionMode?: string;
    allowDangerouslySkipPermissions?: boolean;
    maxTurns?: number;
    systemPrompt?: string | { type: 'preset'; preset: string; append?: string };
    allowedTools?: string[];
    tools?: string[] | { type: 'preset'; preset: string };
    spawnClaudeCodeProcess?: (opts: SdkSpawnOptions) => import('node:child_process').ChildProcess;
    env?: Record<string, string>;
    executable?: string;
    pathToClaudeCodeExecutable?: string;
  };
}

interface SdkMessage {
  type: string;
  [key: string]: unknown;
}

interface SdkModelInfo {
  value: string;
  displayName: string;
  description: string;
}

/** The SDK's Query object — AsyncGenerator with extra control methods. */
interface SdkQuery extends AsyncGenerator<SdkMessage, void> {
  supportedModels(): Promise<SdkModelInfo[]>;
  close(): void;
}

type QueryFn = (opts: SdkQueryOptions) => SdkQuery;

// ── AsyncQueue ──────────────────────────────────────────────────────────────
// A push-based AsyncIterable. Items pushed before consumption are buffered.
// Closing the queue signals the end of the iterable.

class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

// ── Persistent subprocess state ─────────────────────────────────────────────

interface PersistentQuery {
  inputQueue: AsyncQueue<SdkUserMessage>;
  generator: SdkQuery;
  sdkSessionId?: string;
}

// ── Model overrides ─────────────────────────────────────────────────────────
// When the SDK reports stale model IDs (e.g. after a new model release),
// this map replaces them with the current equivalents.

const MODEL_REPLACEMENTS: Record<string, { id: string; name: string; description: string; isDefault?: boolean }> = {
  // Short IDs returned by the SDK
  'default': {
    id: 'claude-haiku-4-5',
    name: 'Default (recommended)',
    description: 'Haiku 4.5 · Fast and lightweight',
    isDefault: true,
  },
  'sonnet': {
    id: 'claude-sonnet-4-6',
    name: 'Sonnet',
    description: 'Sonnet 4.6 · Best for everyday tasks',
  },
  // Full model IDs (fallbacks)
  'claude-sonnet-4-5-20250929': {
    id: 'claude-sonnet-4-6',
    name: 'Sonnet',
    description: 'Sonnet 4.6 · Best for everyday tasks',
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    name: 'Sonnet',
    description: 'Sonnet 4.6 · Best for everyday tasks',
  },
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    name: 'Opus',
    description: 'Opus 4.6 · Most capable for complex work',
  },
  // Short IDs the SDK may return
  'opus': {
    id: 'claude-opus-4-6',
    name: 'Opus',
    description: 'Opus 4.6 · Most capable for complex work',
  },
  'haiku': {
    id: 'claude-haiku-4-5',
    name: 'Default (recommended)',
    description: 'Haiku 4.5 · Fast and lightweight',
    isDefault: true,
  },
};

function applyModelOverrides(models: EngineModelInfo[]): EngineModelInfo[] {
  const mapped = models.map((m) => {
    const replacement = MODEL_REPLACEMENTS[m.id];
    return replacement ? { id: replacement.id, name: replacement.name, description: replacement.description, isDefault: replacement.isDefault } : m;
  });

  // Deduplicate by id (first occurrence wins)
  const seen = new Map<string, EngineModelInfo>();
  for (const m of mapped) {
    if (!seen.has(m.id)) seen.set(m.id, m);
  }

  // Sort so the default model appears first in the picker
  return Array.from(seen.values()).sort((a, b) => {
    const aDefault = (a as { isDefault?: boolean }).isDefault ? 1 : 0;
    const bDefault = (b as { isDefault?: boolean }).isDefault ? 1 : 0;
    return bDefault - aDefault;
  });
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class ClaudeCodeEngine implements ChatEngine {
  readonly engineType: EngineType = 'claude-code';

  private sessions = new Map<string, ChatEngineSession>();
  private abortControllers = new Map<string, AbortController>();
  private persistentQueries = new Map<string, PersistentQuery>();
  private queryFn: QueryFn | null = null;
  private engineManager: EngineManager;
  private cachedModels: EngineModelInfo[] | null = null;

  constructor(engineManager: EngineManager) {
    this.engineManager = engineManager;
  }

  async initialize(): Promise<void> {
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      this.queryFn = (sdk as { query: QueryFn }).query;
      console.log('[claude-code-engine] SDK loaded');
    } catch (err) {
      console.warn('[claude-code-engine] SDK not available:', err);
      this.queryFn = null;
    }
  }

  async isAvailable(): Promise<boolean> {
    // The SDK bundles its own cli.js — no separate `claude` CLI needed.
    // Just check that the SDK loaded successfully.
    return this.queryFn !== null;
  }

  async createSession(opts?: CreateSessionOptions): Promise<ChatEngineSession> {
    const session: ChatEngineSession = {
      id: randomUUID(),
      engineType: 'claude-code',
      model: opts?.model ?? 'claude-haiku-4-5',
      workingDirectory: opts?.workingDirectory,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async resumeSession(sessionId: string): Promise<ChatEngineSession> {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      throw new Error(`Claude Code session not found: ${sessionId}`);
    }
    return existing;
  }

  async sendMessage(
    sessionId: string,
    message: string,
    onEvent: (e: ChatEngineEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.queryFn) {
      throw new Error('Claude Agent SDK is not available');
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);

    // Forward external signal
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const t0 = performance.now();

    try {
      let pq = this.persistentQueries.get(sessionId);
      let isWarmStart = false;

      if (pq && !pq.inputQueue.isClosed) {
        // ── Warm start: reuse existing subprocess ──
        isWarmStart = true;
        const t1 = performance.now();
        console.log(`[claude-code-engine] Timing: warm-start setup=${(t1 - t0).toFixed(0)}ms`);
        pq.inputQueue.push(this.makeSdkUserMessage(message, pq.sdkSessionId ?? ''));
      } else {
        // ── Cold start: spawn new subprocess ──
        // Clean up stale persistent query if present
        if (pq) {
          this.destroyPersistentQuery(sessionId);
        }

        const inputQueue = new AsyncQueue<SdkUserMessage>();
        inputQueue.push(this.makeSdkUserMessage(message, ''));

        const mcpServers = this.buildMcpServers();
        const spawnOverride = this.getSpawnOverride();

        const t1 = performance.now();
        console.log(`[claude-code-engine] Timing: cold-start setup=${(t1 - t0).toFixed(0)}ms`);

        const generator = this.queryFn({
          prompt: inputQueue,
          options: {
            abortController,
            cwd: session.workingDirectory,
            model: session.model,
            mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
            resume: session.externalId,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            spawnClaudeCodeProcess: spawnOverride,
            systemPrompt: {
              type: 'preset',
              preset: 'claude_code',
              append: getClaudeCodeAppend(),
            },
          },
        });

        // Opportunistically cache available models from the first query
        if (!this.cachedModels) {
          generator.supportedModels().then((models) => {
            this.cachedModels = applyModelOverrides(models.map((m) => ({
              id: m.value,
              name: m.displayName,
              description: m.description,
            })));
          }).catch(() => { /* best-effort */ });
        }

        pq = { inputQueue, generator, sdkSessionId: undefined };
        this.persistentQueries.set(sessionId, pq);
      }

      // Consume generator until turn boundary (result message).
      // Using manual .next() instead of for-await to avoid calling
      // generator.return() on break (which would kill the subprocess).
      let firstMsgLogged = false;
      let firstTextLogged = false;

      while (true) {
        const { value: msg, done } = await pq.generator.next();

        if (done) {
          // Subprocess exited — clean up persistent state
          this.persistentQueries.delete(sessionId);
          break;
        }

        // Diagnostic timing
        if (!firstMsgLogged) {
          firstMsgLogged = true;
          const t2 = performance.now();
          console.log(
            `[claude-code-engine] Timing: first-msg=${(t2 - t0).toFixed(0)}ms ` +
            `type=${msg.type} start=${isWarmStart ? 'warm' : 'cold'}`,
          );
        }
        if (!firstTextLogged && (msg.type === 'partial_assistant' || msg.type === 'assistant')) {
          firstTextLogged = true;
          const t3 = performance.now();
          console.log(
            `[claude-code-engine] Timing: first-text=${(t3 - t0).toFixed(0)}ms ` +
            `start=${isWarmStart ? 'warm' : 'cold'}`,
          );
        }

        if (abortController.signal.aborted) {
          // Abort kills the subprocess — clean up
          this.destroyPersistentQuery(sessionId);
          break;
        }

        this.convertMessage(msg, session, onEvent);

        if (msg.type === 'result') {
          // Turn complete — capture SDK session ID, keep subprocess alive
          const resultSessionId = msg.session_id as string | undefined;
          if (resultSessionId) {
            pq.sdkSessionId = resultSessionId;
          }
          break;
        }
      }

      onEvent({ type: 'done' });
    } catch (err) {
      // On error, destroy the persistent subprocess
      this.destroyPersistentQuery(sessionId);

      if (abortController.signal.aborted) {
        onEvent({ type: 'done' });
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', message: errMsg });
    } finally {
      this.abortControllers.delete(sessionId);
    }
  }

  async respondToApproval(
    _sessionId: string,
    _approvalId: string,
    _approved: boolean,
  ): Promise<void> {
    // Claude Agent SDK handles approvals via permissionMode and hooks.
    // In default permission mode, the SDK manages approval prompts internally.
    // For now this is a no-op; full approval flow will be wired in Phase 5.
  }

  async cancelTurn(sessionId: string): Promise<void> {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
    // Abort kills the subprocess; destroy persistent query so the next
    // message starts fresh
    this.destroyPersistentQuery(sessionId);
  }

  async updateSession(sessionId: string, updates: { model?: string }): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (updates.model !== undefined) {
      session.model = updates.model;
      // Model change requires a new subprocess
      this.destroyPersistentQuery(sessionId);
    }
  }

  async prepareForEdit(sessionId: string, _turnsToRollback: number): Promise<void> {
    // Claude Agent SDK has no rollback API. Destroy the persistent subprocess
    // and clear externalId so the next query() creates a fresh session.
    this.destroyPersistentQuery(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) session.externalId = undefined;
  }

  async getAvailableModels(forceRefresh = false): Promise<EngineModelInfo[]> {
    if (!forceRefresh && this.cachedModels) return this.cachedModels;
    if (!this.queryFn) return this.cachedModels ?? [];

    try {
      // Start a lightweight query to discover available models via the SDK
      const q = this.queryFn({
        prompt: 'hi',
        options: {
          maxTurns: 0,
          permissionMode: 'plan',
          tools: [],
        },
      });

      try {
        const models = await q.supportedModels();
        this.cachedModels = applyModelOverrides(models.map((m) => ({
          id: m.value,
          name: m.displayName,
          description: m.description,
        })));
      } finally {
        q.close();
      }

      return this.cachedModels ?? [];
    } catch (err) {
      console.warn('[claude-code-engine] Failed to fetch models dynamically:', err);
      return this.cachedModels ?? [];
    }
  }

  seedModelCache(models: EngineModelInfo[]): void {
    if (!this.cachedModels && models.length > 0) {
      this.cachedModels = applyModelOverrides(models);
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    this.destroyPersistentQuery(sessionId);
    await this.cancelTurn(sessionId);
    this.sessions.delete(sessionId);
  }

  listSessions(): ChatEngineSession[] {
    return Array.from(this.sessions.values());
  }

  async dispose(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      this.destroyPersistentQuery(sessionId);
      await this.cancelTurn(sessionId);
    }
    this.sessions.clear();
    this.abortControllers.clear();
    this.persistentQueries.clear();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private makeSdkUserMessage(text: string, sdkSessionId: string): SdkUserMessage {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: sdkSessionId,
    };
  }

  private buildMcpServers(): Record<string, unknown> {
    const mcpServers: Record<string, unknown> = {};
    const mcpPath = this.engineManager.getMcpServerPath();
    if (mcpPath) {
      mcpServers['conduit'] = {
        type: 'stdio',
        command: 'node',
        args: [mcpPath],
        env: {
          CONDUIT_SOCKET_PATH: getSocketPath(),
          CONDUIT_ENV: getEnvConfig().environment,
          CONDUIT_INTERNAL_AGENT: '1',
        },
      };
    }
    return mcpServers;
  }

  private getSpawnOverride(): ((opts: SdkSpawnOptions) => import('node:child_process').ChildProcess) | undefined {
    // In production, the SDK's cli.js lives inside the ASAR archive.
    // External `node` can't read ASAR files, but Electron's own binary can
    // when run with ELECTRON_RUN_AS_NODE=1.
    return app.isPackaged
      ? (spawnOpts) => {
          return spawn(process.execPath, spawnOpts.args, {
            cwd: spawnOpts.cwd,
            env: { ...spawnOpts.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        }
      : undefined;
  }

  private destroyPersistentQuery(sessionId: string): void {
    const pq = this.persistentQueries.get(sessionId);
    if (pq) {
      pq.inputQueue.close();
      try { pq.generator.close(); } catch { /* already closed */ }
      this.persistentQueries.delete(sessionId);
    }
  }

  // ── Message conversion ──────────────────────────────────────────────────

  private convertMessage(
    msg: SdkMessage,
    session: ChatEngineSession,
    onEvent: (e: ChatEngineEvent) => void,
  ): void {
    switch (msg.type) {
      case 'assistant': {
        // Full assistant message — extract text from content blocks
        const content = msg.message as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> };
        if (content?.content) {
          for (const block of content.content) {
            if (block.type === 'text' && block.text) {
              onEvent({ type: 'text_delta', content: block.text });
            } else if (block.type === 'tool_use') {
              onEvent({
                type: 'tool_start',
                id: block.id ?? randomUUID(),
                name: block.name ?? 'unknown',
                input: block.input,
              });
            }
          }
        }
        break;
      }

      case 'partial_assistant': {
        // Streaming text delta
        const text = msg.text as string | undefined;
        if (text) {
          onEvent({ type: 'text_delta', content: text });
        }
        break;
      }

      case 'result': {
        // Capture session ID for resume (also stored on PersistentQuery)
        const resultSessionId = msg.session_id as string | undefined;
        if (resultSessionId) {
          session.externalId = resultSessionId;
        }

        // Emit usage
        const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        if (usage) {
          onEvent({
            type: 'usage',
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
          });
        }

        if (msg.is_error) {
          onEvent({ type: 'error', message: (msg.result as string) || 'Unknown error' });
        }
        break;
      }

      case 'user':
      case 'user_replay': {
        // Parse tool_result content blocks to emit tool_end events
        const userContent = msg.message as {
          content?: Array<{
            type: string;
            tool_use_id?: string;
            content?: string | Array<{ type: string; text?: string }>;
            is_error?: boolean;
          }>;
        };
        if (userContent?.content) {
          for (const block of userContent.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              let output: string | undefined;
              if (typeof block.content === 'string') {
                output = block.content;
              } else if (Array.isArray(block.content)) {
                output = block.content
                  .filter((b) => b.type === 'text' && b.text)
                  .map((b) => b.text)
                  .join('\n');
              }
              onEvent({
                type: 'tool_end',
                id: block.tool_use_id,
                name: '',
                output: output || undefined,
                isError: block.is_error ?? false,
              });
            }
          }
        }
        break;
      }

      case 'system':
        // System initialization — ignore
        break;

      case 'compact_boundary':
        // Context compaction occurred — ignore
        break;

      default:
        // Unknown message type — log and skip
        console.log(`[claude-code-engine] Unknown message type: ${msg.type}`);
        break;
    }
  }
}
