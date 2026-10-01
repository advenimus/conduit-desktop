/**
 * What Shift+Enter sends in an agent terminal. xterm.js 6 has no kitty keyboard protocol,
 * so Shift+Enter would otherwise arrive as a bare CR and submit the prompt. ESC + CR is
 * Alt+Enter, the binding Claude Code's /terminal-setup installs for VS Code; Codex, Gemini
 * CLI, Grok and Cursor Agent also insert a new line for it.
 */
export const AGENT_NEWLINE_SEQUENCE = "\x1b\r";

const IME_PROCESS_KEY_CODE = 229;

export function isAgentNewlineKey(ev: KeyboardEvent): boolean {
  if (ev.isComposing || ev.keyCode === IME_PROCESS_KEY_CODE) return false;
  return ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
}

export type AgentZoom = "in" | "out" | "reset";

export const AGENT_FONT_SIZE_MIN = 8;
export const AGENT_FONT_SIZE_MAX = 32;

export function nextAgentFontSize(current: number, zoom: Exclude<AgentZoom, "reset">): number {
  const next = current + (zoom === "in" ? 1 : -1);
  return Math.min(AGENT_FONT_SIZE_MAX, Math.max(AGENT_FONT_SIZE_MIN, next));
}
