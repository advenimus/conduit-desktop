import { describe, it, expect } from "vitest";
import { AGENT_NEWLINE_SEQUENCE, isAgentNewlineKey } from "../agentTerminalKeys";

function key(init: KeyboardEventInit & { type?: string } = {}): KeyboardEvent {
  const { type = "keydown", ...rest } = init;
  return new KeyboardEvent(type, { key: "Enter", ...rest });
}

describe("agent terminal newline key", () => {
  it("sends ESC + CR, the Alt+Enter bytes every agent CLI reads as a new line", () => {
    expect(AGENT_NEWLINE_SEQUENCE).toBe("\x1b\r");
  });

  it("matches Shift+Enter on keydown and keypress", () => {
    expect(isAgentNewlineKey(key({ shiftKey: true }))).toBe(true);
    expect(isAgentNewlineKey(key({ type: "keypress", shiftKey: true }))).toBe(true);
  });

  it("leaves plain Enter alone so it still submits", () => {
    expect(isAgentNewlineKey(key())).toBe(false);
  });

  it("leaves other modifier combos with Enter alone", () => {
    expect(isAgentNewlineKey(key({ shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(isAgentNewlineKey(key({ shiftKey: true, altKey: true }))).toBe(false);
    expect(isAgentNewlineKey(key({ shiftKey: true, metaKey: true }))).toBe(false);
    expect(isAgentNewlineKey(key({ altKey: true }))).toBe(false);
  });

  it("ignores Shift with other keys", () => {
    expect(isAgentNewlineKey(key({ key: "a", shiftKey: true }))).toBe(false);
    expect(isAgentNewlineKey(key({ key: "Tab", shiftKey: true }))).toBe(false);
  });

  it("ignores Enter while an IME is composing", () => {
    expect(isAgentNewlineKey(key({ shiftKey: true, isComposing: true }))).toBe(false);
    expect(isAgentNewlineKey(key({ shiftKey: true, keyCode: 229 }))).toBe(false);
  });
});
