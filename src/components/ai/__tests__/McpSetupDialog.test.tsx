import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("../../../lib/electron", () => ({ invoke }));
vi.mock("../../common/Toast", () => ({ toast }));

import McpSetupDialog from "../McpSetupDialog";
import { MCP_TOOL_COMMANDS } from "../mcpCommands";
import { freezeHolders } from "../../../lib/native-freeze";

const writeText = vi.fn();

function panel(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-dialog-content]");
  if (!el) throw new Error("no dialog panel");
  return el;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) =>
    channel === "engine_get_mcp_path" ? "/opt/conduit-mcp" : channel === "engine_get_socket_path" ? "/tmp/conduit.sock" : null,
  );
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(() => {
  cleanup();
  expect(freezeHolders()).toEqual([]);
});

describe("McpSetupDialog (spec 3.12.1)", () => {
  it("is a Dialog on the sync layer with today's title, width and footer", async () => {
    render(<McpSetupDialog onClose={() => {}} />);
    const el = panel();
    expect(el.querySelector("h2")).toHaveTextContent("Register MCP Tools");
    expect(el).toHaveStyle({ maxWidth: "448px" });
    expect(el.parentElement).toHaveAttribute("data-cv-layer", "sync");
    expect(el.querySelector("[data-cv-dialog-footer]")).toHaveTextContent("Got it");
    await screen.findAllByRole("button", { name: "Copy command" });
  });

  it("shows the busy text until both paths are known", () => {
    invoke.mockImplementation(() => new Promise(() => undefined));
    render(<McpSetupDialog onClose={() => {}} />);
    expect(screen.getByText("Loading MCP path...")).toBeVisible();
    expect(document.querySelector(".animate-spin.border-2")).toBeNull();
  });

  it("closes on Escape, on a scrim click, with its close button and with Got it", () => {
    const onClose = vi.fn();
    render(<McpSetupDialog onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    const scrim = panel().parentElement as HTMLElement;
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it("does not close on a click inside the panel", () => {
    const onClose = vi.fn();
    render(<McpSetupDialog onClose={onClose} />);
    fireEvent.mouseDown(panel());
    fireEvent.click(panel());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("lists every agent's command in a code block with a copy button", async () => {
    render(<McpSetupDialog onClose={() => {}} />);
    const buttons = await screen.findAllByRole("button", { name: "Copy command" });
    expect(buttons).toHaveLength(MCP_TOOL_COMMANDS.length);
    const codes = [...panel().querySelectorAll("code")];
    expect(codes.map((c) => c.textContent)).toEqual(MCP_TOOL_COMMANDS.map((t) => t.command("/opt/conduit-mcp", "/tmp/conduit.sock")));
    for (const code of codes) expect(code.parentElement).toHaveClass("bg-code");
    for (const tool of MCP_TOOL_COMMANDS) expect(screen.getByText(tool.label)).toBeInTheDocument();
    expect(buttons[0]).toHaveAttribute("title", "Copy command");
  });

  it("copies a command, confirms with a toast and marks the button as copied", async () => {
    render(<McpSetupDialog onClose={() => {}} />);
    const [first] = await screen.findAllByRole("button", { name: "Copy command" });
    await act(async () => {
      fireEvent.click(first);
    });
    expect(writeText).toHaveBeenCalledWith(MCP_TOOL_COMMANDS[0].command("/opt/conduit-mcp", "/tmp/conduit.sock"));
    expect(toast.success).toHaveBeenCalledWith("Command copied");
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Copy command" })[0]).toHaveClass("text-success"));
  });

  it("reports a failed copy with an error toast", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<McpSetupDialog onClose={() => {}} />);
    const [first] = await screen.findAllByRole("button", { name: "Copy command" });
    await act(async () => {
      fireEvent.click(first);
    });
    expect(toast.error).toHaveBeenCalledWith("Could not copy the command");
    expect(toast.success).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
