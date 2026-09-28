import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AiTab from "../AiTab";
import { useAiStore } from "../../../../stores/aiStore";

vi.mock("../../../../lib/electron", () => ({ invoke: vi.fn(async () => null) }));

describe("AiTab", () => {
  it("shows no MCP tool call counter or limit", () => {
    useAiStore.setState({
      tierCapabilities: { mcp_enabled: true, mcp_daily_quota: -1 } as never,
      engineAvailability: {} as never,
      checkEngineAvailability: async () => {},
    });
    render(<AiTab settings={{ default_engine: "claude-code", cli_font_size: 14 } as never} setSettings={() => {}} onClose={() => {}} />);
    expect(screen.getByText("MCP Server Setup")).toBeTruthy();
    expect(screen.queryByText(/tool calls/i)).toBeNull();
    expect(screen.queryByText(/quota/i)).toBeNull();
  });
});
