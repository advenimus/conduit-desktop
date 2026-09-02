import { describe, it, expect } from "vitest";
import { ENGINE_TYPES as rendererIds, AI_HARNESSES, getHarness, mcpSetupCommand } from "../ai-harnesses";
import { ENGINE_TYPES as mainIds } from "../../../electron/services/ai/cli-harnesses";

describe("renderer harness catalog", () => {
  it("uses the same engine ids as the main-process catalog", () => {
    expect([...rendererIds]).toEqual([...mainIds]);
  });

  it("has one entry per engine id", () => {
    expect(AI_HARNESSES.map((h) => h.id)).toEqual([...rendererIds]);
  });

  it("resolves display metadata for every engine", () => {
    for (const id of rendererIds) {
      const harness = getHarness(id);
      expect(harness.name.length).toBeGreaterThan(0);
      expect(harness.cli.length).toBeGreaterThan(0);
      expect(mcpSetupCommand(id, "/mcp.js", "/tmp.sock").length).toBeGreaterThan(0);
    }
  });
});
