/**
 * Codex Engine — communicates with the OpenAI Codex app-server via
 * a child process using JSONL over stdin/stdout.
 *
 * Protocol: JSON-RPC lite (no "jsonrpc" header), newline-delimited.
 * Lifecycle: initialize → initialized → thread/start → turn/start → events
 */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess, execFile } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { homedir } from 'node:os';
import type {
  ChatEngine,
  ChatEngineEvent,
  ChatEngineSession,
  CreateSessionOptions,
  EngineModelInfo,
  EngineType,
} from './engine.js';
import type { EngineManager } from './engine-manager.js';

// ── Internal types ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  method: string;
  id: number;
  params: Record<string, unknown>;
}

interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface PendingApproval {
  requestId: number;
}

interface CodexSession extends ChatEngineSession {
  threadId?: string;
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class CodexEngine implements ChatEngine {
  readonly engineType: EngineType = 'codex';

  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private sessions = new Map<string, CodexSession>();
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private initialized = false;
  private engineManager: EngineManager;
  private cachedModels: EngineModelInfo[] | null = null;

  /** The event callback for the currently active turn. */
  private activeTurnCallback: ((e: ChatEngineEvent) => void) | null = null;
  private activeTurnSessionId: string | null = null;

  constructor(engineManager: EngineManager) {
    this.engineManager = engineManager;
  }

  async initialize(): Promise<void> {
    // Don't spawn until first session — just check availability
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('codex', ['--version'], { timeout: 5000 }, (err) => {
        resolve(!err);
      });
    });
  }

  async createSession(opts?: CreateSessionOptions): Promise<ChatEngineSession> {
    // Ensure app-server process is running
    await this.ensureProcess();

    // Create a thread on the server
    const result = await this.sendRequest('thread/start', {
      model: opts?.model ?? 'gpt-5.1-codex',
      cwd: opts?.workingDirectory,
      approvalPolicy: 'unlessTrusted',
    }) as { thread: { id: string } };

    const session: CodexSession = {
      id: randomUUID(),
      engineType: 'codex',
      externalId: result.thread.id,
      threadId: result.thread.id,
      model: opts?.model ?? 'gpt-5.1-codex',
      workingDirectory: opts?.workingDirectory,
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(session.id, session);
    return session;
  }

  async resumeSession(sessionId: string): Promise<ChatEngineSession> {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      throw new Error(`Codex session not found: ${sessionId}`);
    }

    await this.ensureProcess();

    // Resume the thread
    if (existing.threadId) {
      await this.sendRequest('thread/resume', {
        threadId: existing.threadId,
      });
    }

    return existing;
  }

  async sendMessage(
    sessionId: string,
    message: string,
    onEvent: (e: ChatEngineEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const session = this.sessions.get(sessionId) as CodexSession | undefined;
    if (!session?.threadId) {
      throw new Error(`Session not found or has no thread: ${sessionId}`);
    }

    await this.ensureProcess();

    // Set up the callback for streaming events
    this.activeTurnCallback = onEvent;
    this.activeTurnSessionId = sessionId;

    // Forward abort signal
    const onAbort = () => {
      this.cancelTurn(sessionId).catch(() => {});
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      // Start a turn
      const result = await this.sendRequest('turn/start', {
        threadId: session.threadId,
        input: [{ type: 'text', text: message }],
        model: session.model,
      }) as { turn: { id: string; status: string } };

      // Wait for turn/completed notification
      await this.waitForTurnComplete(result.turn.id);
    } catch (err) {
      if (signal?.aborted) {
        onEvent({ type: 'done' });
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', message: errMsg });
    } finally {
      this.activeTurnCallback = null;
      this.activeTurnSessionId = null;
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  async respondToApproval(
    _sessionId: string,
    approvalId: string,
    approved: boolean,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      throw new Error(`No pending approval: ${approvalId}`);
    }

    // Send the response back with the original request ID
    this.sendResponse(pending.requestId, {
      decision: approved ? 'accept' : 'decline',
    });

    this.pendingApprovals.delete(approvalId);
  }

  async cancelTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId) as CodexSession | undefined;
    if (!session?.threadId || !this.process) return;

    try {
      await this.sendRequest('turn/interrupt', {
        threadId: session.threadId,
      });
    } catch {
      // Best-effort cancel
    }
  }

  async updateSession(sessionId: string, updates: { model?: string }): Promise<void> {
    const session = this.sessions.get(sessionId) as CodexSession | undefined;
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (updates.model !== undefined) session.model = updates.model;
  }

  async prepareForEdit(sessionId: string, turnsToRollback: number): Promise<void> {
    const session = this.sessions.get(sessionId) as CodexSession | undefined;
    if (!session?.threadId || turnsToRollback <= 0) return;
    await this.ensureProcess();
    await this.sendRequest('thread/rollback', {
      threadId: session.threadId,
      turns: turnsToRollback,
    });
  }

  seedModelCache(models: EngineModelInfo[]): void {
    if (!this.cachedModels && models.length > 0) {
      this.cachedModels = models;
    }
  }

  async getAvailableModels(forceRefresh = false): Promise<EngineModelInfo[]> {
    if (!forceRefresh && this.cachedModels) return this.cachedModels;

    // Codex doesn't expose a dynamic model listing API.
    // Try to read models from the Codex config if available.
    try {
      const { readFile } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const configPath = `${homedir()}/.codex/config.toml`;
      const content = await readFile(configPath, 'utf-8');

      // Extract model references from config (e.g. model = "o3")
      const modelMatch = content.match(/^\s*model\s*=\s*"([^"]+)"/m);
      const configuredModel = modelMatch?.[1];

      // Build list from configured + known models
      const models: EngineModelInfo[] = [];
      const knownModels = ['o4-mini', 'o3', 'gpt-4.1'];

      for (const id of knownModels) {
        models.push({
          id,
          name: id,
          description: id === configuredModel ? 'Configured default' : undefined,
          isDefault: id === (configuredModel ?? 'o4-mini'),
        });
      }

      // Add configured model if not in known list
      if (configuredModel && !knownModels.includes(configuredModel)) {
        models.unshift({
          id: configuredModel,
          name: configuredModel,
          description: 'Configured default',
          isDefault: true,
        });
      }

      this.cachedModels = models;
      return models;
    } catch {
      // Fallback: return known Codex-supported models
      const fallback: EngineModelInfo[] = [
        { id: 'o4-mini', name: 'o4-mini', isDefault: true },
        { id: 'o3', name: 'o3' },
        { id: 'gpt-4.1', name: 'gpt-4.1' },
      ];
      this.cachedModels = fallback;
      return fallback;
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId) as CodexSession | undefined;
    if (session?.threadId && this.process) {
      try {
        await this.sendRequest('thread/archive', { threadId: session.threadId });
      } catch {
        // Best-effort
      }
    }
    this.sessions.delete(sessionId);

    // If no sessions left, kill the process
    if (this.sessions.size === 0) {
      this.killProcess();
    }
  }

  listSessions(): ChatEngineSession[] {
    return Array.from(this.sessions.values());
  }

  async dispose(): Promise<void> {
    this.sessions.clear();
    this.killProcess();
  }

  // ── Process management ──────────────────────────────────────────────────

  private async ensureProcess(): Promise<void> {
    if (this.process && this.initialized) return;
    if (this.process && !this.initialized) {
      // Process started but handshake not done
      await this.handshake();
      return;
    }

    // Spawn codex app-server with explicit env and cwd so it works
    // in production builds where cwd may be inside the .app bundle.
    this.process = spawn('codex', ['--app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      cwd: homedir(),
    });

    // Track spawn errors so we can reject the handshake if spawn fails
    let spawnError: Error | null = null;

    this.process.on('exit', (code) => {
      console.log(`[codex-engine] Process exited with code ${code}`);
      this.process = null;
      this.initialized = false;
      this.readline = null;
      // Reject any pending requests (e.g. handshake) on unexpected exit
      if (!this.initialized) {
        const err = new Error(`Codex process exited with code ${code} during startup`);
        for (const [id, pending] of this.pendingRequests) {
          this.pendingRequests.delete(id);
          pending.reject(err);
        }
      }
    });

    this.process.on('error', (err) => {
      console.error('[codex-engine] Process error:', err);
      spawnError = err;
      // Reject any pending requests on spawn failure
      const spawnErr = new Error(`Failed to spawn codex: ${err.message}`);
      for (const [id, pending] of this.pendingRequests) {
        this.pendingRequests.delete(id);
        pending.reject(spawnErr);
      }
      this.process = null;
      this.initialized = false;
      this.readline = null;
    });

    // Read stdout line by line
    if (this.process.stdout) {
      this.readline = createInterface({ input: this.process.stdout });
      this.readline.on('line', (line) => this.handleLine(line));
    }

    // Log stderr
    if (this.process.stderr) {
      const stderrRl = createInterface({ input: this.process.stderr });
      stderrRl.on('line', (line) => {
        console.log(`[codex-engine:stderr] ${line}`);
      });
    }

    // If spawn already failed synchronously, bail out
    if (spawnError) {
      throw new Error(`Failed to spawn codex: ${(spawnError as Error).message}`);
    }

    await this.handshake();
  }

  private async handshake(): Promise<void> {
    // Send initialize with a timeout — if codex can't start or isn't found,
    // we don't want to hang forever waiting for a response.
    const timeoutMs = 15_000;
    const initPromise = this.sendRequest('initialize', {
      clientInfo: {
        name: 'conduit',
        title: 'Conduit Remote Connection Manager',
        version: '1.0.0',
      },
      capabilities: {},
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(
        'Codex handshake timed out — is `codex` installed and on PATH?'
      )), timeoutMs);
    });

    await Promise.race([initPromise, timeoutPromise]);

    // Send initialized notification
    this.sendNotification('initialized', {});
    this.initialized = true;
    console.log('[codex-engine] Handshake complete');
  }

  private killProcess(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.initialized = false;
    this.readline = null;
    this.pendingRequests.clear();
  }

  // ── JSON-RPC communication ──────────────────────────────────────────────

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;
    const msg: JsonRpcRequest = { method, id, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.writeMessage(msg);

      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Codex request timed out: ${method}`));
        }
      }, 30_000);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const msg: JsonRpcNotification = { method, params };
    this.writeMessage(msg);
  }

  private sendResponse(requestId: number, result: unknown): void {
    const msg = { id: requestId, result };
    this.writeMessage(msg);
  }

  private writeMessage(msg: unknown): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('Codex process stdin not writable');
    }
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn('[codex-engine] Failed to parse line:', line);
      return;
    }

    // Response to our request
    if ('id' in parsed && !('method' in parsed)) {
      const resp = parsed as unknown as JsonRpcResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (pending) {
        this.pendingRequests.delete(resp.id);
        if (resp.error) {
          pending.reject(new Error(resp.error.message));
        } else {
          pending.resolve(resp.result);
        }
      }
      return;
    }

    // Server request (needs response from us — approvals)
    if ('id' in parsed && 'method' in parsed) {
      this.handleServerRequest(parsed as unknown as JsonRpcRequest);
      return;
    }

    // Notification (no id)
    if ('method' in parsed) {
      this.handleNotification(parsed as unknown as JsonRpcNotification);
    }
  }

  // ── Event handling ──────────────────────────────────────────────────────

  private turnCompleteResolvers = new Map<string, () => void>();

  private waitForTurnComplete(turnId: string): Promise<void> {
    return new Promise((resolve) => {
      this.turnCompleteResolvers.set(turnId, resolve);
    });
  }

  private handleNotification(notif: JsonRpcNotification): void {
    const cb = this.activeTurnCallback;
    if (!cb) return;

    const params = notif.params;

    switch (notif.method) {
      // ── Turn lifecycle ──────────────────────────────────────────────
      case 'turn/started':
        // Turn started — nothing to emit yet
        break;

      case 'turn/completed': {
        const turn = params.turn as { id: string; status: string; error?: string } | undefined;
        if (turn?.error) {
          cb({ type: 'error', message: turn.error });
        }
        cb({ type: 'done' });
        // Resolve the wait
        if (turn?.id) {
          const resolver = this.turnCompleteResolvers.get(turn.id);
          if (resolver) {
            this.turnCompleteResolvers.delete(turn.id);
            resolver();
          }
        }
        break;
      }

      // ── Item lifecycle ──────────────────────────────────────────────
      case 'item/started': {
        const item = params.item as { type: string; id: string; command?: string; changes?: unknown[] } | undefined;
        if (!item) break;

        if (item.type === 'commandExecution') {
          cb({
            type: 'command_start',
            id: item.id,
            command: (item as { command?: string }).command ?? '',
          });
        } else if (item.type === 'mcpToolCall') {
          const toolItem = item as { id: string; tool?: string; arguments?: unknown };
          cb({
            type: 'tool_start',
            id: toolItem.id,
            name: (toolItem as { server?: string; tool?: string }).tool ?? 'unknown',
            input: (toolItem as { arguments?: unknown }).arguments,
          });
        }
        break;
      }

      case 'item/completed': {
        const item = params.item as {
          type: string; id: string;
          exitCode?: number; status?: string; text?: string;
          result?: string; error?: string;
          changes?: Array<{ path: string; kind: string; diff?: string }>;
        } | undefined;
        if (!item) break;

        if (item.type === 'commandExecution') {
          cb({
            type: 'command_end',
            id: item.id,
            exitCode: item.exitCode ?? undefined,
          });
        } else if (item.type === 'agentMessage' && item.text) {
          // Final agent message — already streamed via deltas
        } else if (item.type === 'mcpToolCall') {
          cb({
            type: 'tool_end',
            id: item.id,
            name: (item as { tool?: string }).tool ?? 'unknown',
            output: item.result ?? item.error ?? undefined,
            isError: !!item.error,
          });
        } else if (item.type === 'fileChange' && item.changes) {
          for (const change of item.changes) {
            if (change.kind === 'edit' && change.diff) {
              cb({
                type: 'file_edit',
                path: change.path,
                diff: { before: '', after: change.diff },
              });
            } else if (change.kind === 'create') {
              cb({ type: 'file_create', path: change.path, content: '' });
            } else if (change.kind === 'delete') {
              cb({ type: 'file_delete', path: change.path });
            }
          }
        }
        break;
      }

      // ── Streaming deltas ────────────────────────────────────────────
      case 'item/agentMessage/delta': {
        const text = params.text as string | undefined;
        if (text) {
          cb({ type: 'text_delta', content: text });
        }
        break;
      }

      case 'item/commandExecution/outputDelta': {
        const data = params.data as string | undefined;
        const itemId = params.itemId as string | undefined;
        if (data && itemId) {
          cb({ type: 'command_output', id: itemId, content: data });
        }
        break;
      }

      // ── Usage ───────────────────────────────────────────────────────
      case 'thread/tokenUsage/updated': {
        const usage = params as { inputTokens?: number; outputTokens?: number };
        if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
          cb({
            type: 'usage',
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          });
        }
        break;
      }

      default:
        // Ignore unknown notifications
        break;
    }
  }

  private handleServerRequest(req: JsonRpcRequest): void {
    const cb = this.activeTurnCallback;

    switch (req.method) {
      case 'item/commandExecution/requestApproval': {
        const approvalId = randomUUID();
        const params = req.params as {
          itemId?: string;
          reason?: string;
          parsedCmd?: { command?: string[] };
        };

        this.pendingApprovals.set(approvalId, { requestId: req.id });

        const command = params.parsedCmd?.command?.join(' ') ?? '';
        cb?.({
          type: 'approval_request',
          id: approvalId,
          description: params.reason ?? 'Command execution requires approval',
          command,
        });
        break;
      }

      case 'item/fileChange/requestApproval': {
        const approvalId = randomUUID();
        const params = req.params as { itemId?: string; reason?: string };

        this.pendingApprovals.set(approvalId, { requestId: req.id });

        cb?.({
          type: 'approval_request',
          id: approvalId,
          description: params.reason ?? 'File change requires approval',
        });
        break;
      }

      default:
        // Unknown server request — respond with error
        this.sendResponse(req.id, { error: { code: -32601, message: 'Method not found' } });
        break;
    }
  }
}
