import { describe, expect, it } from "vitest";
import type { ReachabilityStatus } from "../../../../types/dashboard";
import { reachabilityHint, reachabilityText } from "../reachabilityCopy";
import { expectedPort, isCheckable } from "../reachabilityTarget";
import { runLimited } from "../runLimited";

const text = (status: ReachabilityStatus, port: number | null = 22, latencyMs: number | null = null) =>
  reachabilityText({ status, port, latencyMs });

describe("reachabilityText", () => {
  it("says under 1 ms for a loopback answer and rounds the rest", () => {
    expect(text("reachable", 22, 0).detail).toBe("Answered in under 1 ms");
    expect(text("reachable", 22, 0.4).detail).toBe("Answered in under 1 ms");
    expect(text("reachable", 22, null).detail).toBe("Answered in under 1 ms");
    expect(text("reachable", 22, 1).detail).toBe("Answered in 1 ms");
    expect(text("reachable", 22, 12.6).detail).toBe("Answered in 13 ms");
  });

  it("gives the badge, tone and detail of every status", () => {
    expect(text("reachable", 22, 24)).toEqual({ badge: "Up", tone: "success", detail: "Answered in 24 ms" });
    expect(text("refused", 3389)).toEqual({ badge: "Port closed", tone: "warning", detail: "Nothing is listening on port 3389" });
    expect(text("timeout")).toEqual({ badge: "No answer", tone: "warning", detail: "No answer in 3 seconds" });
    expect(text("unreachable")).toEqual({ badge: "Down", tone: "danger", detail: "No route to this host" });
    expect(text("not_found")).toEqual({ badge: "Unknown host", tone: "danger", detail: "Could not find this host name" });
    expect(text("invalid", null)).toEqual({
      badge: "Cannot check",
      tone: "neutral",
      detail: "The host or port of this entry is not valid",
    });
    expect(text("not_checkable", null)).toEqual({
      badge: "Cannot check",
      tone: "neutral",
      detail: "This entry has no host and port to check",
    });
  });

  it("words the hint with the port", () => {
    expect(reachabilityHint(5900)).toBe("Direct check from this device to port 5900. Proxies are not used.");
  });
});

describe("reachability targets", () => {
  it("checks ssh, rdp, vnc and web entries that have a host", () => {
    expect(isCheckable({ entry_type: "ssh", host: "10.0.0.1" })).toBe(true);
    expect(isCheckable({ entry_type: "web", host: "https://intranet" })).toBe(true);
    expect(isCheckable({ entry_type: "rdp", host: "  " })).toBe(false);
    expect(isCheckable({ entry_type: "vnc", host: null })).toBe(false);
    expect(isCheckable({ entry_type: "command", host: "10.0.0.1" })).toBe(false);
    expect(isCheckable({ entry_type: "credential", host: "10.0.0.1" })).toBe(false);
  });

  it("uses the entry port or the protocol default", () => {
    expect(expectedPort({ entry_type: "ssh", host: "h", port: null })).toBe(22);
    expect(expectedPort({ entry_type: "ssh", host: "h", port: 2222 })).toBe(2222);
    expect(expectedPort({ entry_type: "rdp", host: "h", port: null })).toBe(3389);
    expect(expectedPort({ entry_type: "vnc", host: "h", port: null })).toBe(5900);
  });

  it("reads a web port from the URL, else 443 for https and 80 for http", () => {
    expect(expectedPort({ entry_type: "web", host: "https://intranet:8443/status", port: null })).toBe(8443);
    expect(expectedPort({ entry_type: "web", host: "http://intranet/", port: null })).toBe(80);
    expect(expectedPort({ entry_type: "web", host: "intranet.example.com", port: null })).toBe(443);
    expect(expectedPort({ entry_type: "web", host: null, port: null })).toBeNull();
  });
});

describe("runLimited", () => {
  it("runs in order with at most the limit at once and keeps going past a failure", async () => {
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    await runLimited([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      started.push(n);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      if (n === 2) throw new Error("boom");
    });
    expect(started).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(4);
  });

  it("resolves at once for no items", async () => {
    await expect(runLimited([], 4, async () => undefined)).resolves.toBeUndefined();
  });
});
