import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const PUBLISHED = "https://raw.githubusercontent.com/advenimus/conduit-desktop/main/release-notes";

// The hook caches the manifest per module, so each test loads a fresh copy.
async function loadHook() {
  vi.resetModules();
  return import("../useReleaseNotes");
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("releaseNotesBase", () => {
  it("reads the local folder only in a preview dev run", async () => {
    const { releaseNotesBase } = await loadHook();
    expect(releaseNotesBase(true, "preview")).toBe("./release-notes");
    expect(releaseNotesBase(true, "")).toBe("./release-notes");
    expect(releaseNotesBase(true, undefined)).toBe("./release-notes");
  });

  it("reads the published notes in a production dev run and in packaged builds", async () => {
    const { releaseNotesBase } = await loadHook();
    expect(releaseNotesBase(true, "production")).toBe(PUBLISHED);
    expect(releaseNotesBase(false, "preview")).toBe(PUBLISHED);
    expect(releaseNotesBase(false, "production")).toBe(PUBLISHED);
  });
});

describe("useReleaseNotes", () => {
  it("loads the releases from a valid manifest", async () => {
    const manifest = { schema_version: 1, releases: [{ version: "1.0.0", title: "First", highlights: [] }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 })));
    const { useReleaseNotes } = await loadHook();
    const { result } = renderHook(() => useReleaseNotes());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.releases.map((r) => r.title)).toEqual(["First"]);
  });

  it("says the manifest is missing when the server answers with an HTML page", async () => {
    const html = "<!doctype html><html><body>app</body></html>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } })));
    const { useReleaseNotes } = await loadHook();
    const { result } = renderHook(() => useReleaseNotes());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.releases).toEqual([]);
    expect(result.current.error).toMatch(/^Release notes manifest is missing or not valid JSON/);
  });
});
