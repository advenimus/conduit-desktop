import type { AgentZoom } from "./agentTerminalKeys";

/** Dispatched on the focused agent terminal's container; TerminalView zooms that terminal only. */
export const AGENT_ZOOM_EVENT = "conduit:agent-zoom";
export const AGENT_TERMINAL_ATTR = "data-agent-terminal";

function isZoom(value: unknown): value is AgentZoom {
  return value === "in" || value === "out" || value === "reset";
}

/** Routes Cmd/Ctrl +, - and 0 from the main process: the focused agent terminal, or else the whole app. */
export function routeZoomKey(zoom: unknown, send: (channel: string, zoom: AgentZoom) => void): void {
  if (!isZoom(zoom)) return;
  const terminal = document.activeElement?.closest(`[${AGENT_TERMINAL_ATTR}]`);
  if (terminal) terminal.dispatchEvent(new CustomEvent<AgentZoom>(AGENT_ZOOM_EVENT, { detail: zoom }));
  else send("zoom-key-app", zoom);
}
