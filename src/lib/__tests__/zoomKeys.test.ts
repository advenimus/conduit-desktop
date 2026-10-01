import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_TERMINAL_ATTR, AGENT_ZOOM_EVENT, routeZoomKey } from "../zoomKeys";

describe("routeZoomKey", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("zooms only the agent terminal that has focus", () => {
    document.body.innerHTML = `<div ${AGENT_TERMINAL_ATTR}><textarea id="a"></textarea></div><div ${AGENT_TERMINAL_ATTR}><textarea id="b"></textarea></div>`;
    const [first, second] = [...document.querySelectorAll(`[${AGENT_TERMINAL_ATTR}]`)];
    const seen: string[] = [];
    first.addEventListener(AGENT_ZOOM_EVENT, (e) => seen.push(`a:${(e as CustomEvent).detail}`));
    second.addEventListener(AGENT_ZOOM_EVENT, (e) => seen.push(`b:${(e as CustomEvent).detail}`));
    const send = vi.fn();
    (document.getElementById("b") as HTMLTextAreaElement).focus();
    routeZoomKey("in", send);
    expect(seen).toEqual(["b:in"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("hands the key back for the app-wide zoom when focus is elsewhere", () => {
    document.body.innerHTML = `<input id="search" />`;
    (document.getElementById("search") as HTMLInputElement).focus();
    const send = vi.fn();
    routeZoomKey("out", send);
    expect(send).toHaveBeenCalledWith("zoom-key-app", "out");
  });

  it("ignores anything that is not a zoom key", () => {
    const send = vi.fn();
    routeZoomKey("sideways", send);
    expect(send).not.toHaveBeenCalled();
  });
});
