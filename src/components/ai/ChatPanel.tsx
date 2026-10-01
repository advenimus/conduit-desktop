import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { ChevronDownIcon } from "../../lib/icons";
import { useAiStore, initEngineStreamListener, initEngineModelRefreshListener } from "../../stores/aiStore";
import type { EngineType } from "../../stores/aiStore";
import { MAX_AGENT_PANES, bindPanesToActiveEngine, useAgentPaneStore } from "../../stores/agentPaneStore";
import { invoke } from "../../lib/electron";
import type { IconComponent, IconProps } from "../../lib/icons";
import { Button, IconButton, Menu, MenuItem } from "../ui";
import EngineLogo from "./EngineLogo";
import { ENGINE_TYPES, getHarness, isEngineType } from "../../lib/ai-harnesses";
import EnginePicker from "./EnginePicker";
import EngineChatView from "./EngineChatView";
import AgentPaneStack from "./AgentPaneStack";

// Stable per-engine components: MenuItem takes an icon component, and a new one per render would remount the logo.
const ENGINE_ICONS: Readonly<Record<EngineType, IconComponent>> = Object.freeze(
  Object.fromEntries(
    ENGINE_TYPES.map((type) => [type, ({ size, className }: IconProps) => <EngineLogo type={type} size={size} className={className} />]),
  ) as Record<EngineType, IconComponent>,
);

export default function ChatPanel() {
  const activeEngineType = useAiStore((s) => s.activeEngineType);
  const activeEngineSessionId = useAiStore((s) => s.activeEngineSessionId);
  const createEngineSession = useAiStore((s) => s.createEngineSession);
  const pendingEngineModel = useAiStore((s) => s.pendingEngineModel);
  const engineSessions = useAiStore((s) => s.engineSessions);
  const terminalMode = useAiStore((s) => s.terminalMode);
  const agentSessionEpoch = useAiStore((s) => s.agentSessionEpoch);
  const paneCount = useAgentPaneStore((s) => s.panes.length);
  const atPaneLimit = paneCount >= MAX_AGENT_PANES;

  const currentEngineModel =
    engineSessions.find((s) => s.id === activeEngineSessionId)?.model ?? pendingEngineModel;

  // First-launch engine picker. Shown until the user explicitly picks an
  // engine; after that the saved default_engine launches silently and the
  // user changes it via Settings → AI → Agent.
  // null = not loaded yet, true = show picker, false = skip picker
  const [pickerNeeded, setPickerNeeded] = useState<boolean | null>(null);

  // Header engine switcher: swaps the focused agent's engine for this session
  // without touching the saved default_engine in settings.
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

  useEffect(() => bindPanesToActiveEngine(), []);

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

  const handleNewAgent = () => {
    useAgentPaneStore.getState().addPane();
  };

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
          {terminalMode ? (
            <IconButton
              icon="plus"
              label="New agent"
              onClick={handleNewAgent}
              disabled={atPaneLimit}
              disabledReason={`Up to ${MAX_AGENT_PANES} agents can run at once`}
            />
          ) : (
            <IconButton icon="plus" label="New conversation" onClick={() => createEngineSession()} />
          )}
        </div>
      </div>

      {terminalMode ? (
        <div className="flex-1 min-h-0 flex flex-col">
          {showPicker && <EnginePicker onPick={() => setPickerNeeded(false)} />}
          {/* Held until pickerNeeded resolves (and is false) so a first-launch user picks before any terminal spawns. */}
          {pickerNeeded === false && <AgentPaneStack epoch={agentSessionEpoch} />}
        </div>
      ) : (
        <EngineChatView
          showPicker={showPicker}
          onPicked={() => setPickerNeeded(false)}
          currentEngineModel={currentEngineModel}
        />
      )}
    </div>
  );
}
