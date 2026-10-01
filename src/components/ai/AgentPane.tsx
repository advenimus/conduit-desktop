import { useEffect, type CSSProperties } from "react";
import { AlertTriangleIcon } from "../../lib/icons";
import { getHarness } from "../../lib/ai-harnesses";
import { useAgentPaneStore, type AgentPane as AgentPaneModel } from "../../stores/agentPaneStore";
import { Button, IconButton, Spinner } from "../ui";
import TerminalView from "../sessions/TerminalView";
import PaneEngineSwitcher from "./PaneEngineSwitcher";
import { useAgentTerminal } from "./useAgentTerminal";

function focusPaneTerminal(paneId: string): void {
  document.querySelector<HTMLTextAreaElement>(`[data-agent-pane="${paneId}"] .xterm-helper-textarea`)?.focus();
}

interface Props {
  pane: AgentPaneModel;
  epoch: number;
  focused: boolean;
  /** One pane looks like the old single agent: no pane header. */
  showHeader: boolean;
  style?: CSSProperties;
}

export default function AgentPane({ pane, epoch, focused, showHeader, style }: Props) {
  const { sessionId, error, loading, retry } = useAgentTerminal(pane.id, pane.engineType, epoch);
  const focusPane = useAgentPaneStore((s) => s.focusPane);
  const closePane = useAgentPaneStore((s) => s.closePane);
  const setPaneEngine = useAgentPaneStore((s) => s.setPaneEngine);
  const name = getHarness(pane.engineType).name;

  // TerminalView skips focusing while another textarea (the other panes' xterm input) holds focus,
  // so a newly opened or restarted focused pane takes keyboard focus itself.
  useEffect(() => {
    if (!sessionId || useAgentPaneStore.getState().focusedPaneId !== pane.id) return;
    const frame = requestAnimationFrame(() => focusPaneTerminal(pane.id));
    return () => cancelAnimationFrame(frame);
  }, [sessionId, pane.id]);

  const close = () => {
    closePane(pane.id);
    requestAnimationFrame(() => focusPaneTerminal(useAgentPaneStore.getState().focusedPaneId));
  };

  return (
    <div
      data-agent-pane={pane.id}
      data-focused={focused ? "" : undefined}
      className="flex min-h-0 basis-0 flex-col"
      style={style}
      onFocus={() => focusPane(pane.id)}
      onMouseDown={() => focusPane(pane.id)}
    >
      {showHeader && (
        <div className="flex h-6 shrink-0 items-center justify-between gap-1 pl-2 pr-2.5">
          <PaneEngineSwitcher engineType={pane.engineType} focused={focused} onSelect={(type) => setPaneEngine(pane.id, type)} />
          <IconButton size="sm" icon="close" label={`Close ${name} agent`} onClick={close} />
        </div>
      )}
      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Spinner size={24} className="text-ink-muted" />
            <span className="text-label text-ink-muted">Starting {name}...</span>
          </div>
        </div>
      )}
      {error && (
        <div className="flex flex-1 items-center justify-center overflow-y-auto px-4">
          <div className="max-w-sm text-center">
            <AlertTriangleIcon size={48} className="mx-auto mb-3 text-danger" />
            <p className="mb-2 text-body font-semibold text-ink-secondary">Failed to start terminal</p>
            <p className="mb-4 text-label text-ink-muted">{error}</p>
            <Button variant="primary" onClick={retry}>
              Retry
            </Button>
          </div>
        </div>
      )}
      {sessionId && (
        <div className="min-h-0 flex-1" data-agent-session={sessionId}>
          <TerminalView sessionId={sessionId} isActive={true} isAgentTerminal />
        </div>
      )}
    </div>
  );
}
