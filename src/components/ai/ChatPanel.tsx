import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { UserIcon, AlertTriangleIcon, PencilIcon, TerminalIcon, ChevronDownIcon } from "../../lib/icons";
import { useAiStore, initEngineStreamListener, initEngineModelRefreshListener, ENGINE_SLASH_COMMANDS } from "../../stores/aiStore";
import type { EngineType } from "../../stores/aiStore";
import { invoke } from "../../lib/electron";
import type { IconComponent, IconProps } from "../../lib/icons";
import { Button, IconButton, Menu, MenuItem, Spinner, cx } from "../ui";
import EngineLogo from "./EngineLogo";
import { ENGINE_TYPES, getHarness, isEngineType } from "../../lib/ai-harnesses";
import EnginePicker from "./EnginePicker";
import ModelPicker from "./ModelPicker";
import MessageBlockRenderer from "./blocks/MessageBlockRenderer";
import TerminalView from "../sessions/TerminalView";

// Stable per-engine components: MenuItem takes an icon component, and a new one per render would remount the logo.
const ENGINE_ICONS: Readonly<Record<EngineType, IconComponent>> = Object.freeze(
  Object.fromEntries(
    ENGINE_TYPES.map((type) => [type, ({ size, className }: IconProps) => <EngineLogo type={type} size={size} className={className} />]),
  ) as Record<EngineType, IconComponent>,
);

const AVATAR = "flex size-8 shrink-0 items-center justify-center rounded-full";
const ASSISTANT_BUBBLE = "border border-card-border bg-well text-ink";

export default function ChatPanel() {
  const {
    activeEngineType,
    activeEngineSessionId,
    engineMessages,
    engineStreamingBlocks,
    engineLoading,
    sendEngineMessage,
    editEngineMessage,
    retryEngineMessage,
    cancelEngineMessage,
    createEngineSession,
    respondToApproval,
  } = useAiStore();

  const showModelPicker = useAiStore((s) => s.showModelPicker);
  const pendingEngineModel = useAiStore((s) => s.pendingEngineModel);
  const engineSessions = useAiStore((s) => s.engineSessions);
  const terminalMode = useAiStore((s) => s.terminalMode);
  const agentSessionEpoch = useAiStore((s) => s.agentSessionEpoch);

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

  // First-launch engine picker. Shown until the user explicitly picks an
  // engine; after that the saved default_engine launches silently and the
  // user changes it via Settings → AI → Agent.
  // null = not loaded yet, true = show picker, false = skip picker
  const [pickerNeeded, setPickerNeeded] = useState<boolean | null>(null);

  // Header engine switcher — lets the user temporarily swap engines for the
  // current session without touching the saved default_engine in settings.
  const [engineSwitcherOpen, setEngineSwitcherOpen] = useState(false);
  const engineSwitcherRef = useRef<HTMLDivElement>(null);
  const engineButtonRef = useRef<HTMLButtonElement>(null);

  const closeEngineSwitcher = () => {
    setEngineSwitcherOpen(false);
    engineButtonRef.current?.focus();
  };

  const onEngineMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    closeEngineSwitcher();
  };

  useEffect(() => {
    if (!engineSwitcherOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (engineSwitcherRef.current && !engineSwitcherRef.current.contains(e.target as Node)) {
        setEngineSwitcherOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [engineSwitcherOpen]);

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

  // Effect: manage terminal mode lifecycle. Held until pickerNeeded resolves
  // (and is false) so a first-launch user picks before any terminal spawns.
  useEffect(() => {
    if (pickerNeeded === null || pickerNeeded === true) return;
    if (terminalMode) {
      cleanupAgentTerminal();
      launchAgentTerminal(activeEngineType);
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
  }, [terminalMode, activeEngineType, pickerNeeded, agentSessionEpoch]);

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
    invoke<{ default_engine?: string; engine_picker_completed?: boolean }>('settings_get').then((s) => {
      const store = useAiStore.getState();
      if (s.default_engine && isEngineType(s.default_engine) && s.default_engine !== store.activeEngineType) {
        store.setActiveEngine(s.default_engine);
      }
      setPickerNeeded(!s.engine_picker_completed);
    }).catch(() => {
      // If settings can't be read, default to showing the picker so the user
      // is never silently auto-launched into an engine they didn't choose.
      setPickerNeeded(true);
    });
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
    cancelEngineMessage();
  };

  const handleNewChat = async () => {
    if (terminalMode) {
      // Terminal mode — restart the terminal with the saved engine.
      cleanupAgentTerminal();
      await launchAgentTerminal(activeEngineType);
      return;
    }
    // Chat mode — start a fresh session.
    await createEngineSession();
  };

  const hasActiveSession = !!activeEngineSessionId;
  const showPicker = pickerNeeded === true;

  return (
    <div className="flex flex-col h-full bg-sidebar">
      <div data-cv-ai-header data-cv-titlebar="" className="flex h-tabstrip shrink-0 items-center justify-between gap-1 px-2">
        <div className="flex min-w-0 items-center gap-1">
          {/* Active engine — click to temporarily swap for this session.
              Doesn't touch the saved default; change that in Settings. */}
          <div className="relative" ref={engineSwitcherRef}>
            <button
              ref={engineButtonRef}
              type="button"
              onClick={() => setEngineSwitcherOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={engineSwitcherOpen}
              className="flex h-6 items-center gap-1.5 rounded px-1.5 text-label font-semibold text-ink-secondary hover:bg-hover hover:text-ink"
              title="Switch engine for this session"
            >
              <EngineLogo type={activeEngineType} size={16} />
              <span>{getHarness(activeEngineType).name}</span>
              <ChevronDownIcon size={16} className="text-ink-muted" />
            </button>
            {engineSwitcherOpen && (
              <div className="absolute top-full left-0 mt-1 z-20 min-w-[200px] max-h-72 overflow-y-auto rounded-lg border border-overlay-border bg-overlay shadow-overlay">
                <Menu onClose={closeEngineSwitcher} onKeyDown={onEngineMenuKeyDown}>
                  {ENGINE_TYPES.map((type) => (
                    <MenuItem
                      key={type}
                      // In-memory only: never write to settings here, so the
                      // next launch still uses the saved default.
                      onSelect={() => useAiStore.getState().setActiveEngine(type)}
                      icon={ENGINE_ICONS[type]}
                      end={activeEngineType === type ? <span className="shrink-0 text-meta text-link">●</span> : undefined}
                    >
                      {getHarness(type).name}
                    </MenuItem>
                  ))}
                </Menu>
              </div>
            )}
          </div>
          {currentEngineModel && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => useAiStore.getState().fetchEngineModels()}
              className="min-w-0 max-w-[160px]"
              title={`Model: ${currentEngineModel} (click to change)`}
            >
              <span className="truncate">{currentEngineModel}</span>
            </Button>
          )}
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton icon="plus" label="New conversation" onClick={handleNewChat} />
        </div>
      </div>

      {/* Messages */}
      {terminalMode ? (
        /* ── Terminal Mode ── */
        <div className="flex-1 min-h-0 flex flex-col">
          {showPicker && (
            <EnginePicker onPick={() => { setPickerNeeded(false); }} />
          )}
          {!showPicker && agentTerminalLoading && (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3">
                <Spinner size={24} className="text-ink-muted" />
                <span className="text-label text-ink-muted">Starting {getHarness(activeEngineType).name}...</span>
              </div>
            </div>
          )}
          {!showPicker && agentTerminalError && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-sm">
                <AlertTriangleIcon size={48} className="mx-auto mb-3 text-danger" />
                <p className="mb-2 text-body font-semibold text-ink-secondary">Failed to start terminal</p>
                <p className="mb-4 text-label text-ink-muted">{agentTerminalError}</p>
                <Button variant="primary" onClick={() => launchAgentTerminal(activeEngineType)}>
                  Retry
                </Button>
              </div>
            </div>
          )}
          {!showPicker && agentTerminalSessionId && !agentTerminalLoading && !agentTerminalError && (
            <div className="flex-1 min-h-0">
              <TerminalView sessionId={agentTerminalSessionId} isActive={true} isAgentTerminal />
            </div>
          )}
        </div>
      ) : (
        /* ── Engine Mode Messages ── */
        <>
          <div className="flex-1 overflow-y-auto p-4 space-y-4 allow-select">
            {/* First-launch picker — replaces the silent default so the user
                explicitly chooses an agent the first time. After they pick,
                this is gated off forever (change in Settings → AI → Agent). */}
            {showPicker && (
              <EnginePicker
                onPick={async () => {
                  setPickerNeeded(false);
                  await createEngineSession();
                }}
              />
            )}

            {/* Post-picker empty state — no active session yet, no messages */}
            {!showPicker && !hasActiveSession && engineMessages.length === 0 && (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <div className="mx-auto mb-3 flex items-center justify-center">
                    <EngineLogo type={activeEngineType} size={48} className="text-ink-faint" />
                  </div>
                  <p className="mb-2 text-body text-ink-secondary">
                    {getHarness(activeEngineType).name} Agent
                  </p>
                  {currentEngineModel && (
                    <p className="mb-2 text-label text-link">{currentEngineModel}</p>
                  )}
                  <p className="mb-4 text-label text-ink-muted">
                    Send a message to start an agent session with MCP tool access
                  </p>
                </div>
              </div>
            )}

            {/* Engine messages */}
            {engineMessages.map((msg, index) => {
              const isUser = msg.role === 'user';
              const isAssistant = msg.role === 'assistant';
              const isSystem = msg.role === 'system';

              const canEdit = isUser && !engineLoading;
              const canRetry = isAssistant && !engineLoading;

              if (isSystem) {
                return (
                  <div key={msg.id} className="flex gap-3 justify-start">
                    <div className={cx(AVATAR, "bg-selected")}>
                      <TerminalIcon size={16} className="text-ink-faint" />
                    </div>
                    <div className="min-w-0 max-w-[85%] rounded-lg border border-card-border bg-well px-4 py-2 text-body text-ink-muted">
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
                    <div className={cx(AVATAR, "bg-accent")}>
                      <EngineLogo type={activeEngineType} size={16} className="text-white" />
                    </div>
                  )}
                  <div className="flex flex-col items-end gap-1 max-w-[85%] min-w-0">
                    <div className={cx("w-full rounded-lg px-4 py-2", isUser ? "bg-btn-primary text-white" : ASSISTANT_BUBBLE)}>
                      {isUser ? (
                        <p className="whitespace-pre-wrap break-words text-body">
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
                      <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        {canEdit && (
                          <IconButton
                            size="sm"
                            icon="pencil"
                            label="Edit message"
                            onClick={() => {
                              setEngineEditingIndex(index);
                              const textContent = msg.blocks
                                .map((b) => b.type === 'text' ? b.content : '')
                                .join('');
                              setInput(textContent);
                              textareaRef.current?.focus();
                            }}
                          />
                        )}
                        {canRetry && (
                          <IconButton size="sm" icon="refresh" label="Regenerate response" onClick={() => retryEngineMessage(index)} />
                        )}
                      </div>
                    )}
                  </div>
                  {isUser && (
                    <div className={cx(AVATAR, "bg-selected text-ink-secondary")}>
                      <UserIcon size={16} />
                    </div>
                  )}
                </div>
              );
            })}

            {/* Engine streaming blocks */}
            {engineStreamingBlocks.length > 0 && (
              <div className="flex gap-3 justify-start">
                <div className={cx(AVATAR, "bg-accent")}>
                  <EngineLogo type={activeEngineType} size={16} className="text-white" />
                </div>
                <div className={cx("min-w-0 max-w-[85%] rounded-lg px-4 py-2", ASSISTANT_BUBBLE)}>
                  <MessageBlockRenderer
                    blocks={engineStreamingBlocks}
                    onApprovalRespond={respondToApproval}
                  />
                  <span className="inline-block h-4 w-2 animate-pulse bg-accent" />
                </div>
              </div>
            )}

            {/* Engine loading indicator */}
            {engineLoading && engineStreamingBlocks.length === 0 && (
              <div className="flex gap-3 justify-start">
                <div className={cx(AVATAR, "bg-accent text-white")}>
                  <Spinner size={16} />
                </div>
                <div className={cx("rounded-lg px-4 py-2", ASSISTANT_BUBBLE)}>
                  <p className="text-body text-ink-muted">{getHarness(activeEngineType).name} is thinking...</p>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Model picker */}
          {showModelPicker && <ModelPicker />}

          {/* Engine input — hidden while the engine picker is showing so the
              user can't bypass the picker by sending a message with the silent
              default engine. */}
          {!showPicker && (
          <div className="relative border-t border-divider p-4">
            {/* Editing indicator */}
            {engineEditingIndex !== null && (
              <div className="mb-2 flex items-center gap-2 text-label text-warning">
                <PencilIcon size={12} />
                <span>
                  Editing message{activeEngineType === 'claude-code'
                    ? ' \u2014 session context will reset from here'
                    : ' \u2014 conversation will restart from here'}
                </span>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setEngineEditingIndex(null);
                    setInput('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}
            {/* Slash command autocomplete popup */}
            {showSlashMenu && filteredSlashCommands.length > 0 && (
              <div className="absolute bottom-full left-4 right-4 z-10 mb-1 overflow-hidden rounded-lg border border-overlay-border bg-overlay p-1 shadow-overlay">
                {filteredSlashCommands.map((cmd, i) => (
                  <button
                    key={cmd.command}
                    type="button"
                    className={cx(
                      "flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-body",
                      i === slashMenuIndex
                        ? "bg-(--c-menu-selection-bg) text-ink outline outline-1 -outline-offset-1 outline-(--c-menu-selection-border)"
                        : "text-ink-secondary",
                    )}
                    onMouseEnter={() => setSlashMenuIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault(); // Prevent blur
                      setInput('');
                      setShowSlashMenu(false);
                      useAiStore.getState().executeEngineSlashCommand(`/${cmd.command}`);
                      textareaRef.current?.focus();
                    }}
                  >
                    <span className="font-mono font-medium text-link">{cmd.label}</span>
                    <span className="text-label text-ink-muted">{cmd.description}</span>
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
                placeholder={engineEditingIndex !== null ? "Edit your message..." : `Message ${getHarness(activeEngineType).name}... (type / then Enter for commands)`}
                className="min-h-[56px] flex-1 resize-none overflow-y-auto rounded border border-input-border bg-input px-2 py-1.5 text-body text-(--c-input-fg) placeholder:text-(--c-input-placeholder) disabled:opacity-40"
                disabled={engineLoading}
              />
              {engineLoading ? (
                <Button
                  size="lg"
                  variant="danger"
                  icon="playerStopFilled"
                  onClick={handleCancel}
                  aria-label="Stop generating"
                  title="Stop generating"
                />
              ) : (
                <Button
                  size="lg"
                  variant="primary"
                  icon="send"
                  onClick={handleSend}
                  disabled={!input.trim()}
                  aria-label="Send message"
                  title="Send message"
                />
              )}
            </div>
          </div>
          )}
        </>
      )}
    </div>
  );
}
