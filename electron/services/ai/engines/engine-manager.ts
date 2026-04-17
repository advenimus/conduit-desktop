/**
 * Engine Manager — singleton that holds all engine instances and
 * dispatches operations to the active engine.
 */

import type {
  ChatEngine,
  ChatEngineEvent,
  ChatEngineSession,
  CreateSessionOptions,
  EngineModelInfo,
  EngineType,
} from './engine.js';

export class EngineManager {
  private engines = new Map<EngineType, ChatEngine>();
  private mcpServerPath: string | null = null;
  private mcpGateCheck: (() => boolean) | null = null;

  /** Register an engine implementation. */
  register(engine: ChatEngine): void {
    this.engines.set(engine.engineType, engine);
  }

  /** Set the path to the MCP server binary (used by SDK engines). */
  setMcpServerPath(p: string): void {
    this.mcpServerPath = p;
  }

  /** Set a gate check function for MCP access (returns false if MCP is not allowed). */
  setMcpGateCheck(fn: () => boolean): void {
    this.mcpGateCheck = fn;
  }

  getMcpServerPath(): string | null {
    if (this.mcpGateCheck && !this.mcpGateCheck()) return null;
    return this.mcpServerPath;
  }

  /** Get a specific engine by type. */
  get(type: EngineType): ChatEngine | undefined {
    return this.engines.get(type);
  }

  /** Initialize all registered engines. */
  async initializeAll(): Promise<void> {
    for (const engine of this.engines.values()) {
      try {
        await engine.initialize();
      } catch (err) {
        console.warn(`[engine-manager] Failed to initialize ${engine.engineType}:`, err);
      }
    }
  }

  /** Check which engines are available. */
  async checkAvailability(): Promise<Record<EngineType, boolean>> {
    const result: Record<string, boolean> = {};
    for (const [type, engine] of this.engines) {
      try {
        result[type] = await engine.isAvailable();
      } catch {
        result[type] = false;
      }
    }
    return result as Record<EngineType, boolean>;
  }

  /** Create a session on the specified engine. */
  async createSession(
    engineType: EngineType,
    opts?: CreateSessionOptions,
  ): Promise<ChatEngineSession> {
    const engine = this.requireEngine(engineType);
    return engine.createSession(opts);
  }

  /** Resume a session. */
  async resumeSession(
    engineType: EngineType,
    sessionId: string,
  ): Promise<ChatEngineSession> {
    const engine = this.requireEngine(engineType);
    return engine.resumeSession(sessionId);
  }

  /** Send a message through the specified engine. */
  async sendMessage(
    engineType: EngineType,
    sessionId: string,
    message: string,
    onEvent: (e: ChatEngineEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const engine = this.requireEngine(engineType);
    return engine.sendMessage(sessionId, message, onEvent, signal);
  }

  /** Respond to an approval. */
  async respondToApproval(
    engineType: EngineType,
    sessionId: string,
    approvalId: string,
    approved: boolean,
  ): Promise<void> {
    const engine = this.requireEngine(engineType);
    return engine.respondToApproval(sessionId, approvalId, approved);
  }

  /** Cancel the current turn. */
  async cancelTurn(
    engineType: EngineType,
    sessionId: string,
  ): Promise<void> {
    const engine = this.requireEngine(engineType);
    return engine.cancelTurn(sessionId);
  }

  /** Update a session's settings (e.g. model). */
  async updateSession(
    engineType: EngineType,
    sessionId: string,
    updates: { model?: string },
  ): Promise<void> {
    const engine = this.requireEngine(engineType);
    if (engine.updateSession) {
      await engine.updateSession(sessionId, updates);
    }
  }

  /** Prepare an engine for edit/retry by rolling back turns. */
  async prepareForEdit(
    engineType: EngineType,
    sessionId: string,
    turnsToRollback: number,
  ): Promise<void> {
    const engine = this.requireEngine(engineType);
    if (engine.prepareForEdit) {
      await engine.prepareForEdit(sessionId, turnsToRollback);
    }
  }

  /** Destroy a session. */
  async destroySession(
    engineType: EngineType,
    sessionId: string,
  ): Promise<void> {
    const engine = this.requireEngine(engineType);
    return engine.destroySession(sessionId);
  }

  /** List sessions across all engines. */
  listAllSessions(): ChatEngineSession[] {
    const all: ChatEngineSession[] = [];
    for (const engine of this.engines.values()) {
      all.push(...engine.listSessions());
    }
    return all;
  }

  /** List sessions for a specific engine. */
  listSessions(engineType: EngineType): ChatEngineSession[] {
    const engine = this.engines.get(engineType);
    return engine ? engine.listSessions() : [];
  }

  /** List available models for an engine. */
  async listModels(engineType: EngineType, forceRefresh = false): Promise<EngineModelInfo[]> {
    const engine = this.requireEngine(engineType);
    if (engine.getAvailableModels) {
      return engine.getAvailableModels(forceRefresh);
    }
    return [];
  }

  /** Dispose all engines. */
  async disposeAll(): Promise<void> {
    for (const engine of this.engines.values()) {
      try {
        await engine.dispose();
      } catch (err) {
        console.warn(`[engine-manager] Failed to dispose ${engine.engineType}:`, err);
      }
    }
    this.engines.clear();
  }

  private requireEngine(type: EngineType): ChatEngine {
    const engine = this.engines.get(type);
    if (!engine) {
      throw new Error(`Engine "${type}" is not registered`);
    }
    return engine;
  }
}
