import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke, listen, type UnlistenFn } from "../../lib/electron";
import { getTerminalTheme } from "../../lib/terminalTheme";
import { useSessionStore } from "../../stores/sessionStore";
import "@xterm/xterm/css/xterm.css";
import {
  CheckIcon, CircleFilledIcon, ClockIcon, CloseIcon, PlayerPlayIcon, PlayerStopIcon, RefreshIcon
} from "../../lib/icons";
import { Button } from "../ui";

// Global registry to preserve Terminal instances across component unmount/remount.
interface CommandEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLDivElement;
  started: boolean;
}
const commandRegistry = new Map<string, CommandEntry>();

/** Clean up a command terminal from the registry (call when session is actually closed) */
export function disposeCommandEntry(sessionId: string): void {
  const entry = commandRegistry.get(sessionId);
  if (entry) {
    entry.terminal.dispose();
    commandRegistry.delete(sessionId);
  }
}

interface CommandViewProps {
  sessionId: string;
  entryId: string;
  isActive?: boolean;
}

type CommandStatus = "running" | "exited" | "error" | "timeout";

export default function CommandView({
  sessionId,
  entryId,
  isActive = true,
}: CommandViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const startedRef = useRef(false);
  const [status, setStatus] = useState<CommandStatus>("running");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [, setError] = useState<string | null>(null);

  // Create or reuse terminal instance
  useEffect(() => {
    if (!terminalRef.current) return;

    // Check if a preserved terminal exists from a previous mount
    const existing = commandRegistry.get(sessionId);
    if (existing) {
      terminalRef.current.appendChild(existing.element);
      fitAddonRef.current = existing.fitAddon;
      startedRef.current = existing.started;
      termRef.current = existing.terminal;
      requestAnimationFrame(() => {
        existing.fitAddon.fit();
      });
      return () => {
        if (existing.element.parentNode) {
          existing.element.parentNode.removeChild(existing.element);
        }
      };
    }

    // First mount: create a new terminal
    const termElement = document.createElement("div");
    termElement.style.width = "100%";
    termElement.style.height = "100%";
    terminalRef.current.appendChild(termElement);

    const term = new Terminal({
      cursorBlink: false,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: getTerminalTheme(),
      scrollback: 10000,
      convertEol: true,
      disableStdin: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    term.open(termElement);

    try {
      const loadWebgl = () => {
        try {
          const addon = new WebglAddon();
          addon.onContextLoss(() => {
            addon.dispose();
            requestAnimationFrame(() => {
              term.refresh(0, term.rows - 1);
              setTimeout(loadWebgl, 200);
            });
          });
          term.loadAddon(addon);
        } catch {
          // Canvas fallback
        }
      };
      loadWebgl();
    } catch {
      // WebGL not available
    }

    fitAddon.fit();
    termRef.current = term;

    // Store in registry for preservation
    commandRegistry.set(sessionId, {
      terminal: term,
      fitAddon,
      element: termElement,
      started: false,
    });

    return () => {
      // On unmount: detach (don't dispose) — preserve in registry
      if (termElement.parentNode) {
        termElement.parentNode.removeChild(termElement);
      }
    };
  }, [sessionId]);

  // Handle resize
  useEffect(() => {
    if (!isActive || !fitAddonRef.current) return;

    const handleResize = () => {
      fitAddonRef.current?.fit();
    };

    const observer = new ResizeObserver(handleResize);
    if (terminalRef.current?.parentElement) {
      observer.observe(terminalRef.current.parentElement);
    }

    // Fit when becoming active
    handleResize();

    return () => observer.disconnect();
  }, [isActive]);

  // Listen for IPC events
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    listen<{ sessionId: string; data: string }>("command:data", (event) => {
      if (event.payload.sessionId === sessionId) {
        termRef.current?.write(event.payload.data);
      }
    }).then((u) => unlisteners.push(u));

    listen<{ sessionId: string; exitCode: number; status: CommandStatus }>(
      "command:exit",
      (event) => {
        if (event.payload.sessionId === sessionId) {
          setExitCode(event.payload.exitCode);
          setStatus(event.payload.status === "timeout" ? "timeout" : "exited");
          useSessionStore
            .getState()
            .updateSessionStatus(sessionId, "disconnected");
        }
      },
    ).then((u) => unlisteners.push(u));

    listen<{ sessionId: string; error: string }>(
      "command:error",
      (event) => {
        if (event.payload.sessionId === sessionId) {
          setError(event.payload.error);
          setStatus("error");
          termRef.current?.write(`\r\n\x1b[31mError: ${event.payload.error}\x1b[0m\r\n`);
          useSessionStore
            .getState()
            .updateSessionStatus(
              sessionId,
              "disconnected",
              event.payload.error,
            );
        }
      },
    ).then((u) => unlisteners.push(u));

    return () => {
      unlisteners.forEach((u) => u());
    };
  }, [sessionId]);

  // Execute command on mount
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const entry = commandRegistry.get(sessionId);
    if (entry) entry.started = true;

    invoke("command_execute", { sessionId, entryId })
      .then(() => {
        useSessionStore
          .getState()
          .updateSessionStatus(sessionId, "connected");
      })
      .catch((err) => {
        const msg =
          err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus("error");
        termRef.current?.write(
          `\r\n\x1b[31mFailed to start: ${msg}\x1b[0m\r\n`,
        );
        useSessionStore
          .getState()
          .updateSessionStatus(sessionId, "disconnected", msg);
      });
  }, [sessionId, entryId]);

  const handleStop = async () => {
    try {
      await invoke("command_cancel", { sessionId });
    } catch {
      // Already stopped
    }
  };

  const handleRerun = async () => {
    setStatus("running");
    setExitCode(null);
    setError(null);
    termRef.current?.clear();
    termRef.current?.write("\x1b[2J\x1b[H"); // Clear screen

    useSessionStore
      .getState()
      .updateSessionStatus(sessionId, "connected");

    try {
      await invoke("command_execute", { sessionId, entryId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus("error");
      termRef.current?.write(
        `\r\n\x1b[31mFailed to start: ${msg}\x1b[0m\r\n`,
      );
      useSessionStore
        .getState()
        .updateSessionStatus(sessionId, "disconnected", msg);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-editor h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-divider bg-editor">
        <div className="flex items-center gap-2 text-label font-semibold">
          <PlayerPlayIcon size={16} className="text-entry-command" />
          <CommandStatusLabel status={status} exitCode={exitCode} />
        </div>
        <div className="flex-1" />
        {status === "running" ? (
          <Button size="sm" variant="danger" icon={PlayerStopIcon} onClick={handleStop}>
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="secondary" icon={RefreshIcon} onClick={handleRerun}>
            Re-run
          </Button>
        )}
      </div>

      {/* Terminal output */}
      <div className="flex-1 relative">
        <div
          ref={terminalRef}
          className="absolute inset-0"
          style={{ padding: "4px" }}
        />
      </div>
    </div>
  );
}

function CommandStatusLabel({ status, exitCode }: { status: CommandStatus; exitCode: number | null }) {
  switch (status) {
    case "running":
      return (
        <span className="flex items-center gap-1.5 text-success">
          <CircleFilledIcon size={12} className="animate-pulse motion-reduce:animate-none" />
          Running
        </span>
      );
    case "exited":
      return exitCode === 0 ? (
        <span className="flex items-center gap-1 text-success">
          <CheckIcon size={16} />
          Exited (0)
        </span>
      ) : (
        <span className="flex items-center gap-1 text-danger">
          <CloseIcon size={16} />
          Exited ({exitCode})
        </span>
      );
    case "timeout":
      return (
        <span className="flex items-center gap-1 text-warning">
          <ClockIcon size={16} />
          Timed Out
        </span>
      );
    case "error":
      return (
        <span className="flex items-center gap-1 text-danger">
          <CloseIcon size={16} />
          Error
        </span>
      );
  }
}
