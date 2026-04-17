import { useState, useRef, useEffect } from "react";
import { SendIcon, LoaderIcon, UserIcon, PlusIcon, AlertTriangleIcon, HistoryIcon, ArrowLeftIcon, PencilIcon, RefreshIcon, PlayerStopFilledIcon, TerminalIcon } from "../../lib/icons";
import { useAiStore, initEngineStreamListener, initEngineModelRefreshListener, ENGINE_SLASH_COMMANDS } from "../../stores/aiStore";
import type { EngineType } from "../../stores/aiStore";
import { invoke } from "../../lib/electron";
import ChatHistoryPanel from "./ChatHistoryPanel";
import EngineLogo from "./EngineLogo";
import EngineSelector from "./EngineSelector";
import ModelPicker from "./ModelPicker";
import MessageBlockRenderer from "./blocks/MessageBlockRenderer";
import ToolApprovalCard from "./ToolApprovalCard";
import { useToolApprovalStore } from "../../stores/toolApprovalStore";
import TerminalView from "../sessions/TerminalView";

export default function ChatPanel() {
  const {
    activeEngineType,
    activeEngineSessionId,
    engineMessages,
    engineStreamingBlocks,
    engineLoading,
    showHistory,
    sendEngineMessage,
    editEngineMessage,
    retryEngineMessage,
    cancelEngineMessage,
    createEngineSession,
    respondToApproval,
    setShowHistory,
    engineSessionReadOnly,
  } = useAiStore();

  const engineAvailability = useAiStore((s) => s.engineAvailability);
  const showModelPicker = useAiStore((s) => s.showModelPicker);
  const pendingEngineModel = useAiStore((s) => s.pendingEngineModel);
  const engineSessions = useAiStore((s) => s.engineSessions);
  const terminalMode = useAiStore((s) => s.terminalMode);

  const currentEngineModel =
    engineSessions.find((s) => s.id === activeEngineSessionId)?.model ?? pendingEngineModel;

  const [input, setInput] = useState("");
  const [engineEditingIndex, setEngineEditingIndex] = useState<number | null>(null);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Agent terminal mode state
  const [agentTerminalSessionId, setAgentTerminalSessionId] = useState<string | null>(null);
  const [agentTerminalError, setAgentTerminalError] = useState<string | null>(null);
  const [agentTerminalLoading, setAgentTerminalLoading] = useState(false);
  const agentTerminalEngineRef = useRef<EngineType | null>(null);

  // Agent terminal lifecycle
  const launchAgentTerminal = async (engineType: EngineType) => {
    setAgentTerminalLoading(true);
    setAgentTerminalError(null);
    try {
      const sessionId = await invoke<string>('agent_terminal_create', { engineType });
      setAgentTerminalSessionId(sessionId);
      agentTerminalEngineRef.current = engineType;
    } catch (err) {
      setAgentTerminalError(err instanceof Error ? err.message : String(err));
    } finally {
      setAgentTerminalLoading(false);
    }
  };

  const cleanupAgentTerminal = () => {
    if (agentTerminalSessionId) {
      invoke('terminal_close', { sessionId: agentTerminalSessionId }).catch(() => {});
      setAgentTerminalSessionId(null);
      agentTerminalEngineRef.current = null;
    }
  };

  // Effect: manage terminal mode lifecycle
  useEffect(() => {
    if (terminalMode) {
      // Need a terminal — launch if not running or engine changed
      if (!agentTerminalSessionId || agentTerminalEngineRef.current !== activeEngineType) {
        cleanupAgentTerminal();
        launchAgentTerminal(activeEngineType);
      }
    } else {
      // Not in terminal mode — cleanup if we had one
      cleanupAgentTerminal();
    }
    return () => {
      // Cleanup on unmount
      if (agentTerminalSessionId) {
        invoke('terminal_close', { sessionId: agentTerminalSessionId }).catch(() => {});
      }
    };
  }, [terminalMode, activeEngineType]);

  // Filtered slash commands for autocomplete
  const filteredSlashCommands = input.startsWith('/') && !input.includes(' ')
    ? ENGINE_SLASH_COMMANDS
        .filter((c) => c.engines.includes(activeEngineType))
        .filter((c) => `/${c.command}`.startsWith(input.toLowerCase()))
    : [];

  // Show/hide slash menu based on input
  useEffect(() => {
    if (input.startsWith('/') && !input.includes(' ') && filteredSlashCommands.length > 0) {
      setShowSlashMenu(true);
      setSlashMenuIndex(0);
    } else {
      setShowSlashMenu(false);
    }
  }, [input, filteredSlashCommands.length]);

  // Initialize stream listeners on mount
  useEffect(() => {
    initEngineStreamListener();
    initEngineModelRefreshListener();

    // Sync AI preferences from persisted settings (survives vault switches)
    invoke<{ default_engine?: string; terminal_mode?: boolean }>('settings_get').then((s) => {
      const store = useAiStore.getState();
      if (s.terminal_mode !== undefined && s.terminal_mode !== store.terminalMode) {
        store.setTerminalMode(s.terminal_mode);
      }
      if (s.default_engine && s.default_engine !== store.activeEngineType) {
        store.setActiveEngine(s.default_engine as EngineType);
      }
    }).catch(() => {});
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [engineMessages, engineStreamingBlocks]);

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(56, Math.min(textarea.scrollHeight, 300))}px`;
  };

  const handleSend = async () => {
    if (!input.trim() || engineLoading) return;
    const msg = input.trim();
    setInput("");
    setShowSlashMenu(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // Handle engine edit mode
    if (engineEditingIndex !== null) {
      const idx = engineEditingIndex;
      setEngineEditingIndex(null);
      await editEngineMessage(idx, msg);
      return;
    }
    // Check for slash commands first
    if (msg.startsWith('/')) {
      const handled = await useAiStore.getState().executeEngineSlashCommand(msg);
      if (handled) return;
    }
    // Create session if needed, then send
    if (!activeEngineSessionId) {
      try {
        await createEngineSession();
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        useAiStore.setState((s) => ({
          engineMessages: [...s.engineMessages, {
            id: crypto.randomUUID(),
            role: 'system' as const,
            blocks: [{ type: 'system' as const, content: errorMsg }],
            timestamp: new Date().toISOString(),
          }],
        }));
        setInput(msg);
        return;
      }
    }
    await sendEngineMessage(msg);
  };

  const handleCancel = () => {
    // Dismiss any pending tool approval cards — the main process cancel
    // handlers also call denyAllPending() to unblock blocked tool calls.
    useToolApprovalStore.getState().dismissAllPending();
    cancelEngineMessage();
  };

  const handleNewChat = async () => {
    if (terminalMode) {
      // Terminal mode — restart the terminal
      cleanupAgentTerminal();
      await launchAgentTerminal(activeEngineType);
      return;
    }
    // Create a new session
    await createEngineSession();
  };

  const hasActiveSession = !!activeEngineSessionId;

  return (
    <div className="flex flex-col h-full bg-canvas">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-stroke">
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          {showHistory ? (
            <>
              <button
                onClick={() => setShowHistory(false)}
                className="p-1 hover:bg-panel rounded text-ink-muted hover:text-ink"
              >
                <ArrowLeftIcon size={16} />
              </button>
              <span className="font-medium text-ink text-sm">Chat History</span>
            </>
          ) : (
            <>
              <EngineSelector />
              {currentEngineModel && (
                <button
                  onClick={() => useAiStore.getState().fetchEngineModels()}
                  className="ml-1 px-2 py-0.5 text-xs text-ink-muted hover:text-ink bg-well hover:bg-raised border border-stroke rounded truncate max-w-[160px]"
                  title={`Model: ${currentEngineModel} (click to change)`}
                >
                  {currentEngineModel}
                </button>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {!showHistory && (
            <button
              onClick={() => setShowHistory(true)}
              className="p-2 hover:bg-panel rounded text-ink-muted hover:text-ink"
              title="Chat history"
            >
              <HistoryIcon size={16} />
            </button>
          )}
          <button
            onClick={handleNewChat}
            className="p-2 hover:bg-panel rounded text-ink-muted hover:text-ink"
            title="New conversation"
          >
            <PlusIcon size={16} />
          </button>
        </div>
      </div>

      {/* History Panel or Messages */}
      {showHistory ? (
        <ChatHistoryPanel />
      ) : terminalMode ? (
        /* ── Terminal Mode ── */
        <div className="flex-1 min-h-0 flex flex-col">
          {agentTerminalLoading && (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3">
                <div className="w-6 h-6 border-2 border-conduit-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-ink-muted">Starting {activeEngineType === 'claude-code' ? 'Claude Code' : 'Codex'}...</span>
              </div>
            </div>
          )}
          {agentTerminalError && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-sm">
                <AlertTriangleIcon size={48} className="text-red-400 mx-auto mb-3" />
                <p className="text-ink-muted mb-2 font-medium">Failed to start terminal</p>
                <p className="text-xs text-ink-faint mb-4">{agentTerminalError}</p>
                <button
                  onClick={() => launchAgentTerminal(activeEngineType)}
                  className="px-4 py-2 bg-conduit-600 hover:bg-conduit-700 text-white rounded-lg text-sm"
                >
                  Retry
                </button>
              </div>
            </div>
          )}
          {agentTerminalSessionId && !agentTerminalLoading && !agentTerminalError && (
            <div className="flex-1 min-h-0">
              <TerminalView sessionId={agentTerminalSessionId} isActive={true} isAgentTerminal />
            </div>
          )}
        </div>
      ) : (
        /* ── Engine Mode Messages ── */
        <>
          <div className="flex-1 overflow-y-auto p-4 space-y-4 allow-select">
            {/* Empty state */}
            {!hasActiveSession && engineMessages.length === 0 && (() => {
              const engineName = activeEngineType === 'claude-code' ? 'Claude Code' : 'Codex';
              const isAvailable = engineAvailability?.[activeEngineType] ?? false;
              const availabilityLoaded = engineAvailability !== null;

              if (availabilityLoaded && !isAvailable) {
                // Engine not installed / not authenticated
                const cliName = activeEngineType === 'claude-code' ? 'claude' : 'codex';
                return (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center max-w-sm">
                      <AlertTriangleIcon size={48} className="text-amber-400 mx-auto mb-3" />
                      <p className="text-ink-muted mb-2 font-medium">{engineName} is not available</p>
                      <p className="text-xs text-ink-faint mb-4">
                        Make sure the <code className="px-1 py-0.5 bg-well rounded text-conduit-300">{cliName}</code> CLI is installed and authenticated. Run:
                      </p>
                      <code className="block px-3 py-2 bg-well border border-stroke rounded text-sm text-ink-muted mb-4">
                        {cliName} login
                      </code>
                      <p className="text-xs text-ink-faint mb-4">
                        After authenticating, restart the app or check status in <strong>Settings &gt; AI</strong>.
                      </p>
                      <button
                        onClick={() => useAiStore.getState().checkEngineAvailability()}
                        className="px-4 py-2 bg-conduit-600 hover:bg-conduit-700 text-white rounded-lg text-sm"
                      >
                        Re-check Availability
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <div className="mx-auto mb-3 flex items-center justify-center">
                      <EngineLogo type={activeEngineType} size={48} className="text-ink-faint" />
                    </div>
                    <p className="text-ink-muted mb-2">
                      {engineName} Agent
                    </p>
                    {currentEngineModel && (
                      <p className="text-xs text-conduit-400 mb-2">{currentEngineModel}</p>
                    )}
                    <p className="text-xs text-ink-faint mb-4">
                      Send a message to start an agent session with MCP tool access
                    </p>
                  </div>
                </div>
              );
            })()}

            {/* Engine messages */}
            {engineMessages.map((msg, index) => {
              const isUser = msg.role === 'user';
              const isAssistant = msg.role === 'assistant';
              const isSystem = msg.role === 'system';

              const canEdit = isUser && !engineLoading && !engineSessionReadOnly;
              const canRetry = isAssistant && !engineLoading && !engineSessionReadOnly;

              if (isSystem) {
                return (
                  <div key={msg.id} className="flex gap-3 justify-start">
                    <div className="w-8 h-8 rounded-full bg-ink-faint/20 flex items-center justify-center flex-shrink-0">
                      <TerminalIcon size={14} className="text-ink-faint" />
                    </div>
                    <div className="max-w-[85%] min-w-0 rounded-lg px-4 py-2 bg-well border border-stroke text-ink-muted text-sm">
                      <MessageBlockRenderer blocks={msg.blocks} />
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={msg.id}
                  className={`group flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}
                >
                  {!isUser && (
                    <div className="w-8 h-8 rounded-full bg-conduit-600 flex items-center justify-center flex-shrink-0">
                      <EngineLogo type={activeEngineType} size={16} className="text-white" />
                    </div>
                  )}
                  <div className="flex flex-col items-end gap-1 max-w-[85%] min-w-0">
                    <div className={`rounded-lg px-4 py-2 w-full ${
                      isUser ? "bg-conduit-600 text-white" : "bg-panel text-ink"
                    }`}>
                      {isUser ? (
                        <p className="whitespace-pre-wrap break-words text-sm">
                          {msg.blocks.map((b) => b.type === 'text' ? b.content : '').join('')}
                        </p>
                      ) : (
                        <MessageBlockRenderer
                          blocks={msg.blocks}
                          onApprovalRespond={respondToApproval}
                        />
                      )}
                    </div>
                    {/* Action buttons — visible on hover */}
                    {(canEdit || canRetry) && (
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {canEdit && (
                          <button
                            onClick={() => {
                              setEngineEditingIndex(index);
                              const textContent = msg.blocks
                                .map((b) => b.type === 'text' ? b.content : '')
                                .join('');
                              setInput(textContent);
                              textareaRef.current?.focus();
                            }}
                            className="p-1 rounded text-ink-faint hover:text-ink hover:bg-panel"
                            title="Edit message"
                          >
                            <PencilIcon size={14} />
                          </button>
                        )}
                        {canRetry && (
                          <button
                            onClick={() => retryEngineMessage(index)}
                            className="p-1 rounded text-ink-faint hover:text-ink hover:bg-panel"
                            title="Regenerate response"
                          >
                            <RefreshIcon size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {isUser && (
                    <div className="w-8 h-8 rounded-full bg-raised flex items-center justify-center flex-shrink-0">
                      <UserIcon size={16} />
                    </div>
                  )}
                </div>
              );
            })}

            {/* Engine streaming blocks */}
            {engineStreamingBlocks.length > 0 && (
              <div className="flex gap-3 justify-start">
                <div className="w-8 h-8 rounded-full bg-conduit-600 flex items-center justify-center flex-shrink-0">
                  <EngineLogo type={activeEngineType} size={16} className="text-white" />
                </div>
                <div className="max-w-[85%] min-w-0 rounded-lg px-4 py-2 bg-panel">
                  <MessageBlockRenderer
                    blocks={engineStreamingBlocks}
                    onApprovalRespond={respondToApproval}
                  />
                  <span className="inline-block w-2 h-4 bg-conduit-400 animate-pulse" />
                </div>
              </div>
            )}

            {/* Engine loading indicator */}
            {engineLoading && engineStreamingBlocks.length === 0 && (
              <div className="flex gap-3 justify-start">
                <div className="w-8 h-8 rounded-full bg-conduit-600 flex items-center justify-center flex-shrink-0">
                  <LoaderIcon size={16} className="animate-spin" />
                </div>
                <div className="rounded-lg px-4 py-2 bg-panel">
                  <p className="text-ink-muted">{activeEngineType === 'claude-code' ? 'Claude Code' : 'Codex'} is thinking...</p>
                </div>
              </div>
            )}

            {/* Inline tool approval cards */}
            <ToolApprovalCard />

            <div ref={messagesEndRef} />
          </div>

          {/* Model picker */}
          {showModelPicker && <ModelPicker />}

          {/* Engine read-only banner */}
          {engineSessionReadOnly && engineMessages.length > 0 && (
            <div className="px-4 py-2 border-t border-stroke bg-amber-900/20 text-amber-300 text-xs text-center">
              This session has expired. Start a new conversation to continue.
            </div>
          )}

          {/* Engine input */}
          <div className="p-4 border-t border-stroke relative">
            {/* Editing indicator */}
            {engineEditingIndex !== null && (
              <div className="flex items-center gap-2 mb-2 text-xs text-amber-400">
                <PencilIcon size={12} />
                <span>
                  Editing message{activeEngineType === 'claude-code'
                    ? ' \u2014 session context will reset from here'
                    : ' \u2014 conversation will restart from here'}
                </span>
                <button
                  onClick={() => {
                    setEngineEditingIndex(null);
                    setInput('');
                  }}
                  className="text-ink-muted hover:text-ink underline"
                >
                  Cancel
                </button>
              </div>
            )}
            {/* Slash command autocomplete popup */}
            {showSlashMenu && filteredSlashCommands.length > 0 && (
              <div className="absolute bottom-full left-4 right-4 mb-1 bg-panel border border-stroke rounded-lg shadow-lg overflow-hidden z-10">
                {filteredSlashCommands.map((cmd, i) => (
                  <button
                    key={cmd.command}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                      i === slashMenuIndex ? 'bg-conduit-600/20 text-ink' : 'text-ink-muted hover:bg-raised'
                    }`}
                    onMouseEnter={() => setSlashMenuIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault(); // Prevent blur
                      setInput('');
                      setShowSlashMenu(false);
                      useAiStore.getState().executeEngineSlashCommand(`/${cmd.command}`);
                      textareaRef.current?.focus();
                    }}
                  >
                    <span className="font-mono text-conduit-400 font-medium">{cmd.label}</span>
                    <span className="text-ink-faint text-xs">{cmd.description}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-2 items-end">
              <textarea
                ref={textareaRef}
                rows={2}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  adjustTextareaHeight();
                }}
                onKeyDown={(e) => {
                  if (showSlashMenu && filteredSlashCommands.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSlashMenuIndex((i) => Math.min(i + 1, filteredSlashCommands.length - 1));
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setSlashMenuIndex((i) => Math.max(i - 1, 0));
                      return;
                    }
                    if (e.key === 'Tab') {
                      e.preventDefault();
                      const cmd = filteredSlashCommands[slashMenuIndex];
                      setInput(`/${cmd.command}${cmd.hasArgs ? ' ' : ''}`);
                      setShowSlashMenu(false);
                      return;
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      const cmd = filteredSlashCommands[slashMenuIndex];
                      setInput('');
                      setShowSlashMenu(false);
                      useAiStore.getState().executeEngineSlashCommand(`/${cmd.command}`);
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setShowSlashMenu(false);
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                  if (e.key === "Escape" && engineEditingIndex !== null) {
                    setEngineEditingIndex(null);
                    setInput('');
                  }
                }}
                placeholder={engineEditingIndex !== null ? "Edit your message..." : `Message ${activeEngineType === 'claude-code' ? 'Claude Code' : 'Codex'}... (type / then Enter for commands)`}
                className="flex-1 px-4 py-2 bg-well border border-stroke rounded-lg focus:outline-none focus:ring-2 focus:ring-conduit-500 text-ink placeholder-ink-faint resize-none overflow-y-auto min-h-[56px]"
                disabled={engineLoading || engineSessionReadOnly}
              />
              {engineLoading ? (
                <button
                  onClick={handleCancel}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg flex items-center justify-center"
                  title="Stop generating"
                >
                  <PlayerStopFilledIcon size={16} />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className="px-4 py-2 bg-conduit-600 hover:bg-conduit-700 text-white disabled:opacity-50 disabled:cursor-not-allowed rounded-lg flex items-center justify-center"
                >
                  <SendIcon size={16} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
