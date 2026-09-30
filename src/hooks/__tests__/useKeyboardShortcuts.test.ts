import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { getShortcuts, useKeyboardShortcuts } from "../useKeyboardShortcuts";

const onHome = vi.fn();

function press(init: KeyboardEventInit, target: EventTarget = document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  onHome.mockReset();
  document.addEventListener("conduit:home", onHome);
  renderHook(() => useKeyboardShortcuts());
});

afterEach(() => {
  document.removeEventListener("conduit:home", onHome);
  document.body.innerHTML = "";
});

describe("Go to Home shortcut", () => {
  it("dispatches conduit:home on Ctrl+Shift+H and Cmd+Shift+H", () => {
    const ctrl = press({ key: "H", ctrlKey: true, shiftKey: true });
    press({ key: "h", metaKey: true, shiftKey: true });
    expect(onHome).toHaveBeenCalledTimes(2);
    expect(ctrl.defaultPrevented).toBe(true);
  });

  it("needs both the modifier and Shift", () => {
    press({ key: "h", ctrlKey: true });
    press({ key: "H", shiftKey: true });
    expect(onHome).not.toHaveBeenCalled();
  });

  it("is skipped while typing in a field or inside a session", () => {
    const input = document.body.appendChild(document.createElement("input"));
    press({ key: "h", ctrlKey: true, shiftKey: true }, input);
    const session = document.body.appendChild(document.createElement("div"));
    session.setAttribute("data-session-keyboard", "");
    const inner = session.appendChild(document.createElement("span"));
    press({ key: "h", ctrlKey: true, shiftKey: true }, inner);
    expect(onHome).not.toHaveBeenCalled();
  });

  it("is listed as Go to Home", () => {
    expect(getShortcuts()).toContainEqual({ key: "h", ctrl: true, alt: undefined, shift: true, description: "Go to Home" });
  });
});
