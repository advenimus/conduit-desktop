import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MessageBlockRenderer from "../MessageBlockRenderer";
import type { MessageBlock } from "../../../../stores/aiStore";

const UPPERCASE = /\b(uppercase|tracking-wide[a-z]*)\b/;

function renderBlocks(blocks: MessageBlock[], onApprovalRespond?: (id: string, approved: boolean) => void) {
  return render(<MessageBlockRenderer blocks={blocks} onApprovalRespond={onApprovalRespond} />);
}

describe("message blocks (R3-AI)", () => {
  it("labels file blocks in title case without CSS uppercase", () => {
    renderBlocks([
      { type: "file_create", path: "src/a.ts", content: "x" },
      { type: "file_edit", path: "src/b.ts", diff: { before: "", after: "y" } },
      { type: "file_delete", path: "src/c.ts" },
    ]);
    for (const label of ["Created", "Edited", "Deleted"]) {
      const el = screen.getByText(label);
      expect(el).toHaveClass("text-meta", "font-semibold");
      expect(el.className).not.toMatch(UPPERCASE);
    }
    expect(screen.getByText("Created")).toHaveClass("text-success");
    expect(screen.getByText("Deleted")).toHaveClass("text-danger");
    expect(screen.getByTitle("src/a.ts")).toHaveTextContent("a.ts");
  });

  it("expands a created file to show its path and content in a code surface", () => {
    renderBlocks([{ type: "file_create", path: "src/a.ts", content: "const a = 1;" }]);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("const a = 1;").parentElement).toHaveClass("bg-code");
  });

  it("shows tool call details under Input and Output labels", () => {
    renderBlocks([{ type: "tool_call", id: "t1", name: "entry_list", input: { q: 1 }, output: "done", status: "success" }]);
    fireEvent.click(screen.getByRole("button"));
    for (const label of ["Input", "Output"]) {
      const el = screen.getByText(label);
      expect(el).toHaveClass("text-meta", "text-ink-muted");
      expect(el.className).not.toMatch(UPPERCASE);
    }
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("shows a running tool with a spinner and no expand when it has no details", () => {
    renderBlocks([{ type: "tool_call", id: "t1", name: "entry_list", input: undefined, status: "running" }]);
    expect(document.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("Input")).toBeNull();
  });

  it("shows a command with its exit code in the status color, expanded while running", () => {
    const { rerender } = renderBlocks([{ type: "command", id: "c1", command: "ls", output: "a b", exitCode: 1, status: "error" }]);
    expect(screen.getByText("exit 1")).toHaveClass("text-danger", "text-badge");
    rerender(<MessageBlockRenderer blocks={[{ type: "command", id: "c2", command: "pwd", output: "/home", status: "running" }]} />);
    expect(screen.getByText("/home")).toBeInTheDocument();
  });

  it("keeps the approval buttons and reports the choice", () => {
    const respond = vi.fn();
    renderBlocks([{ type: "approval", id: "p1", description: "Run a command", command: "rm -rf /tmp/x", status: "pending" }], respond);
    expect(screen.getByText("Run a command").closest(".rounded-md")).toHaveClass("bg-warning-bg", "border-warning-border");
    expect(screen.getByText("rm -rf /tmp/x")).toHaveClass("bg-code");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(respond.mock.calls).toEqual([
      ["p1", true],
      ["p1", false],
    ]);
  });

  it("shows a settled approval's status in title case in its tone", () => {
    renderBlocks([
      { type: "approval", id: "p1", description: "One", status: "approved" },
      { type: "approval", id: "p2", description: "Two", status: "denied" },
    ]);
    expect(screen.getByText("Approved").className).not.toMatch(UPPERCASE);
    expect(screen.getByText("Approved")).toHaveClass("text-success");
    expect(screen.getByText("Denied")).toHaveClass("text-danger");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("shows an error block as a danger callout", () => {
    renderBlocks([{ type: "error", message: "Engine crashed" }]);
    const text = screen.getByText("Engine crashed");
    expect(text.closest(".rounded-md")).toHaveClass("bg-danger-bg", "border-danger-border");
  });

  it("renders markdown text with the code token colors", () => {
    renderBlocks([{ type: "text", content: "Use `npm test`" }]);
    const prose = screen.getByText("npm test").closest(".prose") as HTMLElement;
    expect(prose.className).toContain("prose-pre:bg-code");
    expect(prose.className).toContain("prose-code:text-link");
    expect(prose.className).not.toMatch(/conduit|border-stroke|bg-well/);
  });
});
