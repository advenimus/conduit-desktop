import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke, listen, type UnlistenFn } from "../../lib/electron";
import { getTerminalTheme } from "../../lib/terminalTheme";
import { useSettingsStore } from "../../stores/settingsStore";
import "@xterm/xterm/css/xterm.css";

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

// Global registry to preserve Terminal instances across component unmount/remount.
// When a Pane is restructured (split/collapse), React unmounts and remounts the
// TerminalView. Without this registry, the xterm.js Terminal and its buffer are lost.
interface TerminalEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLDivElement;  // the div that xterm.js rendered into
  started: boolean;         // whether terminal_start was already called
}
const terminalRegistry = new Map<string, TerminalEntry>();

/** Clean up a terminal from the registry (call when session is actually closed) */
export function disposeTerminalEntry(sessionId: string): void {
  const entry = terminalRegistry.get(sessionId);
  if (entry) {
    entry.terminal.dispose();
    terminalRegistry.delete(sessionId);
  }
}

interface TerminalViewProps {
  sessionId: string;
  isActive?: boolean;
  isAgentTerminal?: boolean;
  onClose?: () => void;
  onTitleChange?: (title: string) => void;
}

export default function TerminalView({
  sessionId,
  isActive = true,
  isAgentTerminal = false,
  onClose: _onClose,
  onTitleChange,
}: TerminalViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeTimeoutRef = useRef<number | null>(null);
  const onTitleChangeRef = useRef(onTitleChange);
  const startedRef = useRef(false);
  useEffect(() => { onTitleChangeRef.current = onTitleChange; }, [onTitleChange]);

  // Create or reuse terminal instance
  useEffect(() => {
    if (!terminalRef.current) return;

    // Check if a preserved terminal exists from a previous mount
    const existing = terminalRegistry.get(sessionId);
    if (existing) {
      // Reattach the preserved xterm DOM element into the new container
      terminalRef.current.appendChild(existing.element);
      fitAddonRef.current = existing.fitAddon;
      startedRef.current = existing.started;
      setTerminal(existing.terminal);
      // Re-fit to new container dimensions
      requestAnimationFrame(() => {
        existing.fitAddon.fit();
      });
      return () => {
        // On unmount: detach (don't dispose) — preserve in registry
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

    const termDefaults = useSettingsStore.getState().sessionDefaultsTerminal;
    const term = new Terminal({
      cursorBlink: termDefaults.cursorBlink,
      fontSize: termDefaults.fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: getTerminalTheme(),
      scrollback: termDefaults.scrollback,
      convertEol: true,
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
            // Re-render with canvas fallback, then try reloading WebGL
            requestAnimationFrame(() => {
              term.refresh(0, term.rows - 1);
              setTimeout(loadWebgl, 200);
            });
          });
          term.loadAddon(addon);
        } catch {
          // Canvas fallback is fine
        }
      };
      loadWebgl();
    } catch (e) {
      console.warn("WebGL addon not available:", e);
    }

    fitAddon.fit();

    // Store in registry for preservation
    terminalRegistry.set(sessionId, {
      terminal: term,
      fitAddon,
      element: termElement,
      started: false,
    });
    startedRef.current = false;

    setTerminal(term);

    return () => {
      // On unmount: detach (don't dispose) — preserve in registry
      if (termElement.parentNode) {
        termElement.parentNode.removeChild(termElement);
      }
    };
  }, [sessionId]);

  // Live-update terminal theme when app theme changes
  useEffect(() => {
    if (!terminal) return;
    const handler = () => {
      terminal.options.theme = getTerminalTheme();
    };
    document.addEventListener("conduit:resolved-theme-change", handler);
    return () => document.removeEventListener("conduit:resolved-theme-change", handler);
  }, [terminal]);

  // For agent terminals: apply persisted font size from settings
  useEffect(() => {
    if (!terminal || !isAgentTerminal) return;
    invoke<{ cli_font_size?: number }>('settings_get').then((s) => {
      if (s.cli_font_size && s.cli_font_size !== 14) {
        terminal.options.fontSize = s.cli_font_size;
        fitAddonRef.current?.fit();
      }
    });
  }, [terminal, isAgentTerminal]);

  // For agent terminals: live-update font size from settings slider
  useEffect(() => {
    if (!terminal || !isAgentTerminal) return;
    const handler = (e: Event) => {
      const fontSize = (e as CustomEvent).detail.fontSize;
      terminal.options.fontSize = fontSize;
      fitAddonRef.current?.fit();
    };
    document.addEventListener("conduit:terminal-font-size-change", handler);
    return () => document.removeEventListener("conduit:terminal-font-size-change", handler);
  }, [terminal, isAgentTerminal]);

  // Handle Windows/Linux clipboard shortcuts (Ctrl+C/V, Ctrl+Shift+C/V).
  // On macOS, Cmd+C/V work natively through Electron — no interception needed.
  useEffect(() => {
    if (!terminal || IS_MAC) return;

    terminal.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.type !== "keydown") return true;

      const isCtrl = ev.ctrlKey && !ev.altKey && !ev.metaKey;

      // Ctrl+Shift+C  OR  Ctrl+C with active selection → Copy
      if (isCtrl && ev.key === "c" && (ev.shiftKey || terminal.hasSelection())) {
        const selection = terminal.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch((err) => {
            console.error("Failed to copy terminal selection:", err);
          });
          terminal.clearSelection();
        }
        return false;
      }

      // Ctrl+V or Ctrl+Shift+V → Paste
      if (isCtrl && ev.key === "v") {
        ev.preventDefault(); // prevent browser native paste (would double-paste)
        navigator.clipboard.readText().then((text) => {
          if (text) {
            terminal.paste(text);
          }
        }).catch((err) => {
          console.error("Failed to paste into terminal:", err);
        });
        return false;
      }

      return true;
    });
  }, [terminal]);

  // Re-fit and focus when tab becomes active
  useEffect(() => {
    if (isActive && terminal && fitAddonRef.current) {
      // Defer to next frame so the container has its correct dimensions
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        // Only focus terminal if no input/textarea currently has focus (prevents stealing from AI panel)
        const active = document.activeElement;
        const isInputFocused = active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA' || (active as HTMLElement)?.isContentEditable;
        if (!isInputFocused) {
          terminal.focus();
        }
      });
    }
  }, [isActive, terminal]);

  // Handle window resize with debouncing
  const handleResize = useCallback(() => {
    if (resizeTimeoutRef.current) {
      clearTimeout(resizeTimeoutRef.current);
    }

    resizeTimeoutRef.current = window.setTimeout(() => {
      if (fitAddonRef.current && terminal) {
        fitAddonRef.current.fit();
      }
    }, 100);
  }, [terminal]);

  useEffect(() => {
    window.addEventListener("resize", handleResize);

    if (terminalRef.current) {
      const resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(terminalRef.current);

      return () => {
        window.removeEventListener("resize", handleResize);
        resizeObserver.disconnect();
        if (resizeTimeoutRef.current) {
          clearTimeout(resizeTimeoutRef.current);
        }
      };
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
    };
  }, [handleResize]);

  // Set up data listeners and input handling
  useEffect(() => {
    if (!terminal) return;

    let unlisten: UnlistenFn | undefined;

    const setupListener = async () => {
      unlisten = await listen<{ sessionId: string; data: number[] }>(
        "terminal:data",
        (event) => {
          if (event.payload.sessionId === sessionId) {
            const data = new Uint8Array(event.payload.data);
            terminal.write(data);
          }
        }
      );

      // Only call terminal_start once per session (backend is idempotent but
      // we track it to avoid unnecessary IPC calls on remount)
      if (!startedRef.current) {
        startedRef.current = true;
        const entry = terminalRegistry.get(sessionId);
        if (entry) entry.started = true;
        try {
          await invoke("terminal_start", { sessionId });
        } catch (err) {
          console.error("Failed to start terminal reading:", err);
        }
      }
    };
    setupListener();

    const onData = terminal.onData(async (data) => {
      try {
        await invoke("terminal_write", {
          sessionId,
          data: Array.from(new TextEncoder().encode(data)),
        });
      } catch (err) {
        console.error("Failed to send terminal data:", err);
      }
    });

    const onResize = terminal.onResize(async ({ cols, rows }) => {
      try {
        await invoke("terminal_resize", { sessionId, cols, rows });
      } catch (err) {
        console.error("Failed to resize terminal:", err);
      }
    });

    const onTitleChangeHandler = terminal.onTitleChange((title) => {
      onTitleChangeRef.current?.(title);
    });

    const reportSize = async () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
        const { cols, rows } = terminal;
        try {
          await invoke("terminal_resize", { sessionId, cols, rows });
        } catch (err) {
          console.error("Failed to report initial size:", err);
        }
      }
    };
    reportSize();

    return () => {
      if (unlisten) unlisten();
      onData.dispose();
      onResize.dispose();
      onTitleChangeHandler.dispose();
    };
  }, [terminal, sessionId]);

  return (
    <div data-session-keyboard className="h-full w-full bg-canvas overflow-hidden">
      <div
        ref={terminalRef}
        className="h-full w-full"
        style={{ padding: "4px" }}
      />
    </div>
  );
}
