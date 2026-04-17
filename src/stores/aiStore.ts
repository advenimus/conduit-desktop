import { create } from "zustand";
import { invoke, listen, type UnlistenFn } from "../lib/electron";

export interface PersistentConversationInfo {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  messageCount: number;
  isPinned: boolean;
  engineSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatCloudSyncState {
  status: 'idle' | 'syncing' | 'synced' | 'error' | 'disabled';
  lastSyncedAt: string | null;
  error: string | null;
  enabled: boolean;
}

export interface AiTierCapabilities {
  cli_agents_enabled: boolean;
  mcp_enabled: boolean;
  mcp_daily_quota: number;
  chat_cloud_sync_enabled: boolean;
  tier_name: string;
  tier_display_name: string;
  is_team_member: boolean;
}

// ── Engine types (unified AI engine abstraction) ────────────────────────────

export type EngineType = 'claude-code' | 'codex';

export type MessageBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; output?: string; status: 'running' | 'success' | 'error' }
  | { type: 'file_edit'; path: string; diff: { before: string; after: string } }
  | { type: 'file_create'; path: string; content: string }
  | { type: 'file_delete'; path: string }
  | { type: 'command'; id: string; command: string; output: string; exitCode?: number; status: 'running' | 'success' | 'error' }
  | { type: 'approval'; id: string; description: string; command?: string; status: 'pending' | 'approved' | 'denied' }
  | { type: 'error'; message: string }
  | { type: 'system'; content: string };

export interface EngineMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: MessageBlock[];
  timestamp: string;
}

export interface EngineSessionInfo {
  id: string;
  engineType: EngineType;
  externalId?: string;
  model?: string;
  workingDirectory?: string;
  createdAt: string;
}

export interface EngineModelInfo {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
}

export interface EngineAvailability {
  'claude-code': boolean;
  codex: boolean;
}

interface AiState {
  tierCapabilities: AiTierCapabilities | null;

  // Persistent history state
  persistentConversations: PersistentConversationInfo[];
  historyLoading: boolean;
  historySearchQuery: string;
  showHistory: boolean;

  // Chat cloud sync state
  chatSyncState: ChatCloudSyncState | null;

  // Engine state (unified AI engine abstraction)
  activeEngineType: EngineType;
  engineAvailability: EngineAvailability | null;
  engineSessions: EngineSessionInfo[];
  activeEngineSessionId: string | null;
  engineMessages: EngineMessage[];
  engineStreamingBlocks: MessageBlock[];
  engineLoading: boolean;
  engineTokenUsage: { inputTokens: number; outputTokens: number };
  showModelPicker: boolean;
  engineModelOptions: EngineModelInfo[];

  // Engine conversation persistence
  activeEngineConversationId: string | null;
  engineSessionReadOnly: boolean;

  // Terminal mode
  terminalMode: boolean;

  // Actions
  deleteConversation: (id: string) => Promise<void>;
  fetchTierCapabilities: () => Promise<void>;
  setLocalModeTier: () => void;
  loadCachedTier: () => Promise<void>;

  // Persistent history actions
  loadPersistentConversations: (search?: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  setShowHistory: (show: boolean) => void;
  setHistorySearchQuery: (query: string) => void;

  // Chat cloud sync actions
  fetchChatSyncState: () => Promise<void>;
  enableChatSync: () => Promise<void>;
  disableChatSync: () => Promise<void>;
  syncChatNow: () => Promise<void>;
  deleteChatCloudData: () => Promise<void>;

  // Terminal mode actions
  setTerminalMode: (enabled: boolean) => void;

  // Engine actions
  setActiveEngine: (type: EngineType) => void;
  checkEngineAvailability: () => Promise<void>;
  createEngineSession: (opts?: { model?: string; workingDirectory?: string }) => Promise<string>;
  sendEngineMessage: (message: string) => Promise<void>;
  editEngineMessage: (messageIndex: number, newContent: string) => Promise<void>;
  retryEngineMessage: (assistantMessageIndex: number) => Promise<void>;
  cancelEngineMessage: () => Promise<void>;
  respondToApproval: (approvalId: string, approved: boolean) => Promise<void>;
  destroyEngineSession: (sessionId: string) => Promise<void>;
  loadPersistedEngineSessions: () => Promise<void>;
  resumeEngineSession: (sessionId: string, engineType: EngineType) => Promise<void>;
  executeEngineSlashCommand: (input: string) => Promise<boolean>;
  fetchEngineModels: () => Promise<void>;
  selectEngineModel: (modelId: string) => Promise<void>;
  closeModelPicker: () => void;
  pendingEngineModel: string | null;

  // Engine conversation persistence actions
  loadEngineConversationHistory: (conversationId: string) => Promise<void>;
  loadEngineSessionMessages: (sessionId: string) => Promise<void>;

  // Vault switch
  resetConversationState: () => void;
}

// ── Slash command definitions ────────────────────────────────────────────────

export interface SlashCommandDef {
  command: string;
  label: string;
  description: string;
  engines: EngineType[];
  hasArgs?: boolean;
}

export const ENGINE_SLASH_COMMANDS: SlashCommandDef[] = [
  { command: 'model', label: '/model', description: 'Switch to a different model', engines: ['claude-code', 'codex'], hasArgs: true },
  { command: 'clear', label: '/clear', description: 'Start a new session', engines: ['claude-code', 'codex'] },
  { command: 'cost', label: '/cost', description: 'Show token usage for this session', engines: ['claude-code', 'codex'] },
  { command: 'help', label: '/help', description: 'Show available commands', engines: ['claude-code', 'codex'] },
];

function addEngineSystemMessage(content: string) {
  const msg: EngineMessage = {
    id: crypto.randomUUID(),
    role: 'system',
    blocks: [{ type: 'system', content }],
    timestamp: new Date().toISOString(),
  };
  useAiStore.setState((s) => ({
    engineMessages: [...s.engineMessages, msg],
  }));
}

export const useAiStore = create<AiState>((set, get) => ({
  tierCapabilities: null,

  // Persistent history
  persistentConversations: [],
  historyLoading: false,
  historySearchQuery: "",
  showHistory: false,

  // Chat cloud sync
  chatSyncState: null,

  // Engine state
  activeEngineType: 'claude-code' as EngineType,
  engineAvailability: null,
  engineSessions: [],
  activeEngineSessionId: null,
  engineMessages: [],
  engineStreamingBlocks: [],
  engineLoading: false,
  engineTokenUsage: { inputTokens: 0, outputTokens: 0 },
  showModelPicker: false,
  engineModelOptions: [],
  pendingEngineModel: null,
  activeEngineConversationId: null,
  engineSessionReadOnly: false,
  terminalMode: false,

  resetConversationState: () => set({
    persistentConversations: [],
    historyLoading: false,
    historySearchQuery: "",
    showHistory: false,
    chatSyncState: null,
    // NOTE: activeEngineType and terminalMode are intentionally NOT reset here.
    // They are user preferences persisted in settings.json and should survive vault switches.
    engineSessions: [],
    activeEngineSessionId: null,
    activeEngineConversationId: null,
    engineMessages: [],
    engineStreamingBlocks: [],
    engineLoading: false,
    engineTokenUsage: { inputTokens: 0, outputTokens: 0 },
    showModelPicker: false,
    pendingEngineModel: null,
    engineSessionReadOnly: false,
  }),

  deleteConversation: async (id) => {
    await invoke("ai_delete_conversation", { conversationId: id });
    const state = get();
    if (state.activeEngineConversationId === id) {
      set({ activeEngineConversationId: null, activeEngineSessionId: null, engineMessages: [] });
    }
    await get().loadPersistentConversations(get().historySearchQuery || undefined);
  },

  fetchTierCapabilities: async () => {
    try {
      const caps = await invoke<AiTierCapabilities>("ai_get_tier_capabilities");
      set({ tierCapabilities: caps });
    } catch (err) {
      console.error("Failed to fetch tier capabilities:", err);
    }
  },

  setLocalModeTier: () => {
    set({
      tierCapabilities: {
        cli_agents_enabled: true,
        mcp_enabled: true,
        mcp_daily_quota: 50,
        chat_cloud_sync_enabled: false,
        tier_name: 'local',
        tier_display_name: 'Local',
        is_team_member: false,
      },
    });
  },

  loadCachedTier: async () => {
    try {
      const cached = await invoke<AiTierCapabilities | null>('ai_get_cached_tier_capabilities');
      if (cached) {
        set({ tierCapabilities: cached as AiTierCapabilities });
      } else {
        // Fall back to free tier
        get().setLocalModeTier();
      }
    } catch {
      get().setLocalModeTier();
    }
  },

  // Persistent history actions
  loadPersistentConversations: async (search) => {
    set({ historyLoading: true });
    try {
      const data = await invoke<PersistentConversationInfo[]>(
        "chat_list_conversations",
        { search, limit: 100 }
      );
      set({ persistentConversations: data, historyLoading: false });
    } catch (err) {
      console.error("Failed to load persistent conversations:", err);
      set({ historyLoading: false });
    }
  },

  renameConversation: async (id, title) => {
    try {
      await invoke("chat_update_conversation", { conversationId: id, title });
      await get().loadPersistentConversations(get().historySearchQuery || undefined);
    } catch (err) {
      console.error("Failed to rename conversation:", err);
    }
  },

  setShowHistory: (show) => {
    set({ showHistory: show });
    if (show) {
      get().loadPersistentConversations();
    }
  },

  setHistorySearchQuery: (query) => {
    set({ historySearchQuery: query });
    get().loadPersistentConversations(query || undefined);
  },

  // Chat cloud sync actions
  fetchChatSyncState: async () => {
    try {
      const state = await invoke<ChatCloudSyncState>("chat_cloud_sync_get_state");
      set({ chatSyncState: state });
    } catch (err) {
      console.error("Failed to fetch chat sync state:", err);
    }
  },

  enableChatSync: async () => {
    await invoke("chat_cloud_sync_enable");
    await get().fetchChatSyncState();
  },

  disableChatSync: async () => {
    await invoke("chat_cloud_sync_disable");
    await get().fetchChatSyncState();
  },

  syncChatNow: async () => {
    await invoke("chat_cloud_sync_now");
    await get().fetchChatSyncState();
  },

  deleteChatCloudData: async () => {
    await invoke("chat_cloud_sync_delete");
    await get().fetchChatSyncState();
  },

  // ── Terminal mode ──────────────────────────────────────────────────────

  setTerminalMode: (enabled) => set({ terminalMode: enabled }),

  // ── Engine actions ──────────────────────────────────────────────────────

  setActiveEngine: (type) => {
    const prev = get().activeEngineType;
    if (prev !== type) {
      set({
        activeEngineType: type,
        engineSessionReadOnly: false,
        activeEngineConversationId: null,
        activeEngineSessionId: null,
        engineMessages: [],
        engineStreamingBlocks: [],
        engineTokenUsage: { inputTokens: 0, outputTokens: 0 },
      });
    }
  },

  checkEngineAvailability: async () => {
    try {
      const availability = await invoke<EngineAvailability>("engine_check_availability");
      set({ engineAvailability: availability });
    } catch (err) {
      console.error("Failed to check engine availability:", err);
    }
  },

  createEngineSession: async (opts) => {
    const state = get();
    const engineType = state.activeEngineType;

    // Guard: check availability before creating sessions
    const available = state.engineAvailability?.[engineType] ?? false;
    if (!available) {
      const name = engineType === 'claude-code' ? 'Claude Code' : 'Codex';
      const cli = engineType === 'claude-code' ? 'claude' : 'codex';
      throw new Error(`${name} is not available. Install and authenticate the '${cli}' CLI, then restart the app.`);
    }

    // Cancel any in-flight request on the current session before creating a new one.
    // Without this, the old session's 'done' event gets silently dropped by the
    // stream listener's session ID guard, leaving engineLoading stuck true forever.
    if (state.activeEngineSessionId && state.engineLoading) {
      try {
        await invoke("engine_cancel_turn", {
          engineType,
          sessionId: state.activeEngineSessionId,
        });
      } catch {
        // Best-effort — the session may already be gone
      }
    }

    // Use pending model if no explicit model provided
    const model = opts?.model ?? state.pendingEngineModel ?? undefined;

    const session = await invoke<EngineSessionInfo>("engine_create_session", {
      engineType,
      model,
      workingDirectory: opts?.workingDirectory,
    });
    set((s) => ({
      engineSessions: [...s.engineSessions, session],
      activeEngineSessionId: session.id,
      engineMessages: [],
      engineStreamingBlocks: [],
      engineLoading: false,
      engineTokenUsage: { inputTokens: 0, outputTokens: 0 },
      pendingEngineModel: null,
      activeEngineConversationId: null,
      engineSessionReadOnly: false,
    }));
    return session.id;
  },

  sendEngineMessage: async (message) => {
    const state = get();
    if (!state.activeEngineSessionId || state.engineLoading) return;

    // Add user message
    const userMsg: EngineMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      blocks: [{ type: 'text', content: message }],
      timestamp: new Date().toISOString(),
    };

    set((s) => ({
      engineMessages: [...s.engineMessages, userMsg],
      engineLoading: true,
      engineStreamingBlocks: [],
    }));

    try {
      await invoke("engine_send_message", {
        engineType: state.activeEngineType,
        sessionId: state.activeEngineSessionId,
        message,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Failed to send engine message:", errorMsg);
      set({ engineLoading: false });
    }
  },

  editEngineMessage: async (messageIndex, newContent) => {
    const state = get();
    if (!state.activeEngineSessionId || state.engineLoading) return;

    // Truncate frontend messages to the edit point and add the new user message
    const truncated = state.engineMessages.slice(0, messageIndex);
    const userMsg: EngineMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      blocks: [{ type: 'text', content: newContent }],
      timestamp: new Date().toISOString(),
    };

    set({
      engineMessages: [...truncated, userMsg],
      engineLoading: true,
      engineStreamingBlocks: [],
    });

    try {
      await invoke("engine_edit_message", {
        engineType: state.activeEngineType,
        sessionId: state.activeEngineSessionId,
        messageIndex,
        newMessage: newContent,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Failed to edit engine message:", errorMsg);
      set({ engineLoading: false });
    }
  },

  retryEngineMessage: async (assistantMessageIndex) => {
    const state = get();
    if (!state.activeEngineSessionId || state.engineLoading) return;

    // Walk backward to find the preceding user message
    let userIndex = -1;
    let userContent = '';
    for (let i = assistantMessageIndex - 1; i >= 0; i--) {
      if (state.engineMessages[i].role === 'user') {
        userIndex = i;
        const textBlock = state.engineMessages[i].blocks.find((b) => b.type === 'text');
        userContent = textBlock && textBlock.type === 'text' ? textBlock.content : '';
        break;
      }
    }
    if (userIndex === -1 || !userContent) return;

    // Truncate to user index and re-add the user message
    const truncated = state.engineMessages.slice(0, userIndex);
    const userMsg: EngineMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      blocks: [{ type: 'text', content: userContent }],
      timestamp: new Date().toISOString(),
    };

    set({
      engineMessages: [...truncated, userMsg],
      engineLoading: true,
      engineStreamingBlocks: [],
    });

    try {
      await invoke("engine_retry_message", {
        engineType: state.activeEngineType,
        sessionId: state.activeEngineSessionId,
        userMessageIndex: userIndex,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Failed to retry engine message:", errorMsg);
      set({ engineLoading: false });
    }
  },

  cancelEngineMessage: async () => {
    const state = get();
    if (!state.activeEngineSessionId || !state.engineLoading) return;
    await invoke("engine_cancel_turn", {
      engineType: state.activeEngineType,
      sessionId: state.activeEngineSessionId,
    });
  },

  respondToApproval: async (approvalId, approved) => {
    const state = get();
    if (!state.activeEngineSessionId) return;
    await invoke("engine_respond_approval", {
      engineType: state.activeEngineType,
      sessionId: state.activeEngineSessionId,
      approvalId,
      approved,
    });

    // Update the approval block status
    set((s) => ({
      engineStreamingBlocks: s.engineStreamingBlocks.map((b) =>
        b.type === 'approval' && b.id === approvalId
          ? { ...b, status: approved ? 'approved' as const : 'denied' as const }
          : b
      ),
      engineMessages: s.engineMessages.map((m) => ({
        ...m,
        blocks: m.blocks.map((b) =>
          b.type === 'approval' && b.id === approvalId
            ? { ...b, status: approved ? 'approved' as const : 'denied' as const }
            : b
        ),
      })),
    }));
  },

  destroyEngineSession: async (sessionId) => {
    const state = get();
    try {
      await invoke("engine_destroy_session", {
        engineType: state.activeEngineType,
        sessionId,
      });
    } catch (err) {
      console.error("Failed to destroy engine session:", err);
    }
    set((s) => ({
      engineSessions: s.engineSessions.filter((es) => es.id !== sessionId),
      activeEngineSessionId: s.activeEngineSessionId === sessionId ? null : s.activeEngineSessionId,
      engineMessages: s.activeEngineSessionId === sessionId ? [] : s.engineMessages,
    }));
  },

  loadPersistedEngineSessions: async () => {
    try {
      const sessions = await invoke<EngineSessionInfo[]>("engine_list_persisted_sessions", {});
      set({ engineSessions: sessions });
    } catch (err) {
      console.error("Failed to load persisted engine sessions:", err);
    }
  },

  executeEngineSlashCommand: async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return false;

    const parts = trimmed.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');
    const state = get();
    const engineType = state.activeEngineType;

    switch (command) {
      case 'help':
      case 'commands': {
        const available = ENGINE_SLASH_COMMANDS.filter((c) => c.engines.includes(engineType));
        const lines = available.map((c) =>
          `\`/${c.command}\` — ${c.description}`
        );
        addEngineSystemMessage('**Available Commands**\n\n' + lines.join('\n'));
        return true;
      }

      case 'model': {
        if (args) {
          // Direct model switch: /model <name>
          if (state.activeEngineSessionId) {
            try {
              await invoke('engine_update_session', {
                engineType,
                sessionId: state.activeEngineSessionId,
                updates: { model: args },
              });
              set((s) => ({
                engineSessions: s.engineSessions.map((es) =>
                  es.id === state.activeEngineSessionId ? { ...es, model: args } : es
                ),
              }));
              addEngineSystemMessage(`Model switched to **${args}**.`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              addEngineSystemMessage(`Failed to switch model: ${msg}`);
            }
          } else {
            // No session yet — store as pending
            set({ pendingEngineModel: args });
            addEngineSystemMessage(`Model set to **${args}**. It will be used when the session starts.`);
          }
          return true;
        }
        // No args — open the model picker
        await get().fetchEngineModels();
        return true;
      }

      case 'clear': {
        try {
          await get().createEngineSession();
          addEngineSystemMessage('Started a new session.');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addEngineSystemMessage(`Failed to create new session: ${msg}`);
        }
        return true;
      }

      case 'cost': {
        const usage = state.engineTokenUsage;
        addEngineSystemMessage(
          '**Token Usage (this session)**\n\n' +
          `- Input tokens: **${usage.inputTokens.toLocaleString()}**\n` +
          `- Output tokens: **${usage.outputTokens.toLocaleString()}**\n` +
          `- Total: **${(usage.inputTokens + usage.outputTokens).toLocaleString()}**`
        );
        return true;
      }

      default: {
        addEngineSystemMessage(`Unknown command: \`/${command}\`. Type \`/help\` for available commands.`);
        return true;
      }
    }
  },

  resumeEngineSession: async (sessionId, engineType) => {
    try {
      const session = await invoke<EngineSessionInfo>("engine_resume_session", {
        engineType,
        sessionId,
      });
      set((s) => ({
        activeEngineType: engineType,
        activeEngineSessionId: session.id,
        engineMessages: s.engineMessages.length > 0 ? s.engineMessages : [],
        engineStreamingBlocks: [],
        engineSessionReadOnly: false,
        // Update the session in the list if externalId changed
        engineSessions: s.engineSessions.map((es) =>
          es.id === sessionId ? { ...es, ...session } : es
        ),
      }));
    } catch (err) {
      console.error("Failed to resume engine session:", err);
      // Remove stale session from local state
      set((s) => ({
        engineSessions: s.engineSessions.filter((es) => es.id !== sessionId),
      }));
    }
  },

  fetchEngineModels: async () => {
    const state = get();
    try {
      const models = await invoke<EngineModelInfo[]>("engine_list_models", {
        engineType: state.activeEngineType,
      });
      set({ engineModelOptions: models, showModelPicker: true });
    } catch (err) {
      console.error("Failed to fetch engine models:", err);
      addEngineSystemMessage('Failed to fetch available models.');
    }
  },

  selectEngineModel: async (modelId) => {
    const state = get();
    set({ showModelPicker: false });

    if (state.activeEngineSessionId) {
      try {
        await invoke('engine_update_session', {
          engineType: state.activeEngineType,
          sessionId: state.activeEngineSessionId,
          updates: { model: modelId },
        });
        set((s) => ({
          engineSessions: s.engineSessions.map((es) =>
            es.id === state.activeEngineSessionId ? { ...es, model: modelId } : es
          ),
        }));
        addEngineSystemMessage(`Model switched to **${modelId}**.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addEngineSystemMessage(`Failed to switch model: ${msg}`);
      }
    } else {
      // No session yet — store as pending model for when session starts
      set({ pendingEngineModel: modelId });
      addEngineSystemMessage(`Model set to **${modelId}**. It will be used when the session starts.`);
    }
  },

  closeModelPicker: () => {
    set({ showModelPicker: false });
  },

  // ── Engine conversation persistence ────────────────────────────────

  loadEngineConversationHistory: async (conversationId: string) => {
    try {
      // Load messages from backend
      const messages = await invoke<Array<{
        id: string;
        role: string;
        blocks: unknown[];
        createdAt: string;
      }>>('engine_load_conversation_messages', { conversationId });

      // Convert to EngineMessage format
      const engineMsgs: EngineMessage[] = messages.map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant' | 'system',
        blocks: m.blocks as MessageBlock[],
        timestamp: m.createdAt,
      }));

      // Find the conversation to get engine info
      const conversations = get().persistentConversations;
      const conv = conversations.find((c) => c.id === conversationId);

      if (conv) {
        const engineType = conv.provider as EngineType;
        const availability = get().engineAvailability;
        const isAvailable = availability?.[engineType] ?? false;

        set({
          activeEngineType: engineType,
          activeEngineSessionId: null,
          engineMessages: engineMsgs,
          engineStreamingBlocks: [],
          activeEngineConversationId: conversationId,
          engineTokenUsage: { inputTokens: 0, outputTokens: 0 },
          showHistory: false,
        });

        // Try to resume the engine session if available
        if (conv.engineSessionId && isAvailable) {
          try {
            await get().resumeEngineSession(conv.engineSessionId, engineType);
            set({ engineSessionReadOnly: false });
          } catch {
            // Session expired — read-only mode
            set({
              activeEngineSessionId: null,
              engineSessionReadOnly: true,
            });
          }
        } else {
          // No session to resume
          set({
            activeEngineSessionId: null,
            engineSessionReadOnly: !isAvailable,
          });
        }
      }
    } catch (err) {
      console.error('Failed to load engine conversation history:', err);
    }
  },

  loadEngineSessionMessages: async (sessionId: string) => {
    try {
      // Find if there's an existing conversation for this session
      const conv = await invoke<{ id: string; engineSessionId: string } | null>(
        'engine_find_conversation', { engineSessionId: sessionId }
      );

      if (conv) {
        const messages = await invoke<Array<{
          id: string;
          role: string;
          blocks: unknown[];
          createdAt: string;
        }>>('engine_load_conversation_messages', { conversationId: conv.id });

        const engineMsgs: EngineMessage[] = messages.map((m) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant' | 'system',
          blocks: m.blocks as MessageBlock[],
          timestamp: m.createdAt,
        }));

        set({
          engineMessages: engineMsgs,
          activeEngineConversationId: conv.id,
          engineSessionReadOnly: false,
        });
      }
    } catch (err) {
      console.error('Failed to load engine session messages:', err);
    }
  },
}));

// Set up chat sync state listener
let chatSyncUnlisten: UnlistenFn | null = null;

export function initChatSyncListener() {
  if (chatSyncUnlisten) return;

  listen<ChatCloudSyncState>("chat-sync:state-changed", (event) => {
    useAiStore.setState({ chatSyncState: event.payload });
  }).then((unlisten) => {
    chatSyncUnlisten = unlisten;
  });
}

// ── Engine stream listener ──────────────────────────────────────────────────

interface EngineStreamPayload {
  sessionId: string;
  engineType: EngineType;
  event: {
    type: string;
    content?: string;
    id?: string;
    name?: string;
    input?: unknown;
    output?: string;
    isError?: boolean;
    path?: string;
    diff?: { before: string; after: string };
    command?: string;
    exitCode?: number;
    description?: string;
    message?: string;
    inputTokens?: number;
    outputTokens?: number;
  };
}

let engineStreamUnlisten: UnlistenFn | null = null;
let engineStreamListenerInitializing = false;

export function initEngineStreamListener() {
  if (engineStreamUnlisten || engineStreamListenerInitializing) return;
  engineStreamListenerInitializing = true;

  listen<EngineStreamPayload>("ai:engine-stream", (event) => {
    const { sessionId, event: engineEvent } = event.payload;
    const store = useAiStore.getState();

    // Only process events for the active session.
    // Safety net: if a 'done' event arrives from an orphaned session while
    // engineLoading is stuck true (e.g. race between cancel and done), reset it.
    if (sessionId !== store.activeEngineSessionId) {
      if (engineEvent.type === 'done' && store.engineLoading) {
        useAiStore.setState({ engineLoading: false });
      }
      return;
    }

    switch (engineEvent.type) {
      case 'text_delta': {
        if (!engineEvent.content) break;
        // Append to last text block or create new one
        useAiStore.setState((s) => {
          const blocks = [...s.engineStreamingBlocks];
          const last = blocks[blocks.length - 1];
          if (last?.type === 'text') {
            blocks[blocks.length - 1] = { ...last, content: last.content + engineEvent.content! };
          } else {
            blocks.push({ type: 'text', content: engineEvent.content! });
          }
          return { engineStreamingBlocks: blocks };
        });
        break;
      }

      case 'tool_start': {
        useAiStore.setState((s) => ({
          engineStreamingBlocks: [...s.engineStreamingBlocks, {
            type: 'tool_call' as const,
            id: engineEvent.id!,
            name: engineEvent.name!,
            input: engineEvent.input,
            status: 'running' as const,
          }],
        }));
        break;
      }

      case 'tool_end': {
        useAiStore.setState((s) => ({
          engineStreamingBlocks: s.engineStreamingBlocks.map((b) =>
            b.type === 'tool_call' && b.id === engineEvent.id
              ? { ...b, output: engineEvent.output, status: (engineEvent.isError ? 'error' : 'success') as 'error' | 'success' }
              : b
          ),
        }));
        break;
      }

      case 'file_edit': {
        useAiStore.setState((s) => ({
          engineStreamingBlocks: [...s.engineStreamingBlocks, {
            type: 'file_edit' as const,
            path: engineEvent.path!,
            diff: engineEvent.diff!,
          }],
        }));
        break;
      }

      case 'file_create': {
        useAiStore.setState((s) => ({
          engineStreamingBlocks: [...s.engineStreamingBlocks, {
            type: 'file_create' as const,
            path: engineEvent.path!,
            content: engineEvent.content ?? '',
          }],
        }));
        break;
      }

      case 'file_delete': {
        useAiStore.setState((s) => ({
          engineStreamingBlocks: [...s.engineStreamingBlocks, {
            type: 'file_delete' as const,
            path: engineEvent.path!,
          }],
        }));
        break;
      }

      case 'command_start': {
        useAiStore.setState((s) => ({
          engineStreamingBlocks: [...s.engineStreamingBlocks, {
            type: 'command' as const,
            id: engineEvent.id!,
            command: engineEvent.command!,
            output: '',
            status: 'running' as const,
          }],
        }));
        break;
      }

      case 'command_output': {
        useAiStore.setState((s) => ({
          engineStreamingBlocks: s.engineStreamingBlocks.map((b) =>
            b.type === 'command' && b.id === engineEvent.id
              ? { ...b, output: b.output + (engineEvent.content ?? '') }
              : b
          ),
        }));
        break;
      }

      case 'command_end': {
        useAiStore.setState((s) => ({
          engineStreamingBlocks: s.engineStreamingBlocks.map((b) =>
            b.type === 'command' && b.id === engineEvent.id
              ? { ...b, exitCode: engineEvent.exitCode, status: (engineEvent.exitCode === 0 ? 'success' : 'error') as 'success' | 'error' }
              : b
          ),
        }));
        break;
      }

      case 'approval_request': {
        useAiStore.setState((s) => ({
          engineStreamingBlocks: [...s.engineStreamingBlocks, {
            type: 'approval' as const,
            id: engineEvent.id!,
            description: engineEvent.description!,
            command: engineEvent.command,
            status: 'pending' as const,
          }],
        }));
        break;
      }

      case 'usage': {
        useAiStore.setState((s) => ({
          engineTokenUsage: {
            inputTokens: s.engineTokenUsage.inputTokens + (engineEvent.inputTokens ?? 0),
            outputTokens: s.engineTokenUsage.outputTokens + (engineEvent.outputTokens ?? 0),
          },
        }));
        break;
      }

      case 'error': {
        useAiStore.setState((s) => ({
          engineStreamingBlocks: [...s.engineStreamingBlocks, {
            type: 'error' as const,
            message: engineEvent.message ?? 'Unknown error',
          }],
        }));
        break;
      }

      case 'done': {
        // Finalize: move streaming blocks into a message.
        // Any blocks still in 'running' state (e.g. cancelled mid-flight)
        // get marked as 'error' so they don't show a perpetual spinner.
        const streamingBlocks = useAiStore.getState().engineStreamingBlocks.map((b) => {
          if (b.type === 'tool_call' && b.status === 'running') {
            return { ...b, status: 'error' as const };
          }
          if (b.type === 'command' && b.status === 'running') {
            return { ...b, status: 'error' as const };
          }
          return b;
        });
        if (streamingBlocks.length > 0) {
          const assistantMsg: EngineMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            blocks: streamingBlocks,
            timestamp: new Date().toISOString(),
          };
          useAiStore.setState((s) => ({
            engineMessages: [...s.engineMessages, assistantMsg],
            engineStreamingBlocks: [],
            engineLoading: false,
          }));
        } else {
          useAiStore.setState({ engineStreamingBlocks: [], engineLoading: false });
        }
        break;
      }
    }
  }).then((unlisten) => {
    engineStreamUnlisten = unlisten;
  });
}

// ── Engine model refresh listener ──────────────────────────────────────────

let engineModelRefreshUnlisten: UnlistenFn | null = null;
let engineModelRefreshInitializing = false;

export function initEngineModelRefreshListener() {
  if (engineModelRefreshUnlisten || engineModelRefreshInitializing) return;
  engineModelRefreshInitializing = true;

  listen<Record<string, { models: EngineModelInfo[]; updatedAt: string }>>(
    'engine:models-refreshed',
    (event) => {
      const updated = event.payload;
      const state = useAiStore.getState();
      const activeType = state.activeEngineType;

      if (updated[activeType]) {
        useAiStore.setState({ engineModelOptions: updated[activeType].models });
      }
    },
  ).then((unlisten) => {
    engineModelRefreshUnlisten = unlisten;
  });
}
