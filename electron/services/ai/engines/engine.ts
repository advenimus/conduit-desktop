/**
 * Unified AI Engine abstraction.
 *
 * All engines (Claude Code SDK, Codex app-server) implement this interface.
 * The EngineManager selects the active engine and forwards requests from
 * the IPC layer.
 */

// ── Engine types ────────────────────────────────────────────────────────────

export type EngineType = 'claude-code' | 'codex';

// ── Session ─────────────────────────────────────────────────────────────────

export interface ChatEngineSession {
  id: string;
  engineType: EngineType;
  /** Engine-specific external session/thread ID (e.g. Claude session ID). */
  externalId?: string;
  model?: string;
  workingDirectory?: string;
  createdAt: string;
}

// ── Rich message blocks (displayed in UI) ───────────────────────────────────

export type MessageBlock =
  | { type: 'text'; content: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      input: unknown;
      output?: string;
      status: 'running' | 'success' | 'error';
    }
  | { type: 'file_edit'; path: string; diff: { before: string; after: string } }
  | { type: 'file_create'; path: string; content: string }
  | { type: 'file_delete'; path: string }
  | {
      type: 'command';
      id?: string;
      command: string;
      output: string;
      exitCode?: number;
      status: 'running' | 'success' | 'error';
    }
  | {
      type: 'approval';
      id: string;
      description: string;
      command?: string;
      status: 'pending' | 'approved' | 'denied';
    }
  | { type: 'error'; message: string };

export interface EngineMessage {
  id: string;
  role: 'user' | 'assistant';
  blocks: MessageBlock[];
  timestamp: string;
}

// ── Streaming events (main → renderer) ──────────────────────────────────────

export type ChatEngineEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_start'; id: string; name: string; input?: unknown }
  | { type: 'tool_end'; id: string; name: string; output?: string; isError?: boolean }
  | { type: 'tool_output'; id: string; content: string }
  | { type: 'file_edit'; path: string; diff: { before: string; after: string } }
  | { type: 'file_create'; path: string; content: string }
  | { type: 'file_delete'; path: string }
  | { type: 'command_start'; id: string; command: string }
  | { type: 'command_output'; id: string; content: string }
  | { type: 'command_end'; id: string; exitCode?: number }
  | { type: 'approval_request'; id: string; description: string; command?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'done' };

// ── Model info ──────────────────────────────────────────────────────────────

export interface EngineModelInfo {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
}

// ── Engine interface ────────────────────────────────────────────────────────

export interface CreateSessionOptions {
  model?: string;
  workingDirectory?: string;
}

export interface ChatEngine {
  readonly engineType: EngineType;

  /** One-time setup (install checks, etc.). */
  initialize(): Promise<void>;

  /** Can this engine be used right now? (CLI installed, authenticated, etc.) */
  isAvailable(): Promise<boolean>;

  /** Start a fresh session. */
  createSession(opts?: CreateSessionOptions): Promise<ChatEngineSession>;

  /** Resume a previous session (if the engine supports it). */
  resumeSession(sessionId: string): Promise<ChatEngineSession>;

  /**
   * Send a user message and stream events back via `onEvent`.
   * Resolves when the full turn is complete.
   */
  sendMessage(
    sessionId: string,
    message: string,
    onEvent: (e: ChatEngineEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;

  /** Respond to an approval request from the engine. */
  respondToApproval(
    sessionId: string,
    approvalId: string,
    approved: boolean,
  ): Promise<void>;

  /** Cancel the current in-flight turn. */
  cancelTurn(sessionId: string): Promise<void>;

  /** Destroy a session and free resources. */
  destroySession(sessionId: string): Promise<void>;

  /** List all active sessions for this engine. */
  listSessions(): ChatEngineSession[];

  /** Update session settings (model, etc.) between turns. */
  updateSession?(sessionId: string, updates: { model?: string }): Promise<void>;

  /**
   * Prepare the engine's internal state for an edit/retry from a given point.
   * Called before resending from the edit point.
   * @param turnsToRollback Number of user/assistant turn pairs to remove from the end.
   */
  prepareForEdit?(sessionId: string, turnsToRollback: number): Promise<void>;

  /** Return the list of models available for this engine. */
  getAvailableModels?(forceRefresh?: boolean): Promise<EngineModelInfo[]>;

  /** Seed the in-memory model cache from persisted data (disk). */
  seedModelCache?(models: EngineModelInfo[]): void;

  /** Tear down the engine and all sessions. */
  dispose(): Promise<void>;
}
