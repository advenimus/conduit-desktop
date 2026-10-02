import { useEffect, useState } from "react";
import { invoke } from "../../lib/electron";
import type { EngineType } from "../../stores/aiStore";
import { disposeTerminalEntry } from "../sessions/TerminalView";

export function closeAgentTerminal(sessionId: string): void {
  invoke("terminal_close", { sessionId })
    .catch((err) => console.error("Failed to close the agent terminal:", err))
    .finally(() => disposeTerminalEntry(sessionId));
}

interface LaunchResult {
  key: string;
  sessionId: string | null;
  error: string | null;
}

export interface AgentTerminal {
  sessionId: string | null;
  error: string | null;
  loading: boolean;
  retry: () => void;
}

/** Runs one agent terminal for a pane. A new engine, epoch or retry ends the old terminal and starts a fresh one. */
export function useAgentTerminal(paneId: string, engineType: EngineType, epoch: number): AgentTerminal {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const launchKey = `${paneId}|${engineType}|${epoch}|${attempt}`;

  useEffect(() => {
    // Locals, not state: the cleanup must close the terminal this run created, even one that arrives after it.
    let cancelled = false;
    let sessionId: string | null = null;
    invoke<string>("agent_terminal_create", { engineType, paneId })
      .then((id) => {
        if (cancelled) {
          closeAgentTerminal(id);
          return;
        }
        sessionId = id;
        setResult({ key: launchKey, sessionId: id, error: null });
      })
      .catch((err) => {
        if (!cancelled) setResult({ key: launchKey, sessionId: null, error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
      if (sessionId) closeAgentTerminal(sessionId);
    };
  }, [launchKey, engineType, paneId]);

  const current = result?.key === launchKey ? result : null;
  return {
    sessionId: current?.sessionId ?? null,
    error: current?.error ?? null,
    loading: current === null,
    retry: () => setAttempt((a) => a + 1),
  };
}
