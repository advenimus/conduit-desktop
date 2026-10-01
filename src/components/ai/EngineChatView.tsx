import { useState, useRef, useEffect } from "react";
import { UserIcon, PencilIcon, TerminalIcon } from "../../lib/icons";
import { useAiStore, ENGINE_SLASH_COMMANDS } from "../../stores/aiStore";
import { Button, IconButton, Spinner, cx } from "../ui";
import EngineLogo from "./EngineLogo";
import { getHarness } from "../../lib/ai-harnesses";
import EnginePicker from "./EnginePicker";
import ModelPicker from "./ModelPicker";
import MessageBlockRenderer from "./blocks/MessageBlockRenderer";

const AVATAR = "flex size-8 shrink-0 items-center justify-center rounded-full";
const ASSISTANT_BUBBLE = "border border-card-border bg-well text-ink";

interface Props {
  showPicker: boolean;
  onPicked: () => void;
  currentEngineModel: string | null;
}

/** The chat-style engine mode. Unused while CLI agents run as terminals; kept working. */
export default function EngineChatView({ showPicker, onPicked, currentEngineModel }: Props) {
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

  const [input, setInput] = useState("");
  const [engineEditingIndex, setEngineEditingIndex] = useState<number | null>(null);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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


  const hasActiveSession = !!activeEngineSessionId;

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4 space-y-4 allow-select">
        {/* First-launch picker — replaces the silent default so the user
            explicitly chooses an agent the first time. After they pick,
            this is gated off forever (change in Settings → AI → Agent). */}
        {showPicker && (
          <EnginePicker
            onPick={async () => {
              onPicked();
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
  );
}
