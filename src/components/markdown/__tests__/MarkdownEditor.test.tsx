import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import MarkdownEditor from "../MarkdownEditor";
import { MARKDOWN_PROSE_CLASSES } from "../markdownProseClasses";
import { toolbarActions } from "../markdownToolbar";

function Harness({ initial = "", onChange }: { initial?: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <MarkdownEditor
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

describe("MarkdownEditor (restyle)", () => {
  it("renders Write and Preview as a panel Tabs strip", () => {
    render(<Harness />);
    const list = screen.getByRole("tablist");
    expect(list).toHaveClass("h-part-title");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Write", "Preview"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveClass("bg-selected-inactive");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tabs[0].id);
  });

  it("keeps every toolbar button with its title, as IconButtons", () => {
    const { container } = render(<Harness />);
    const titles = toolbarActions.flatMap((a) => ("separator" in a ? [] : [a.title]));
    for (const title of titles) {
      const button = screen.getByTitle(title);
      expect(button).toHaveAttribute("aria-label", title);
      expect(button).toHaveClass("size-5");
    }
    expect(container.querySelector(".bg-well, .bg-raised\\/50, .border-conduit-500")).toBeNull();
  });

  it("a toolbar action still edits the text", () => {
    const onChange = vi.fn();
    render(<Harness initial="hello" onChange={onChange} />);
    const textarea = screen.getByPlaceholderText("Write markdown...") as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 5);
    const first = toolbarActions.flatMap((a) => ("separator" in a ? [] : [a.title]))[0];
    fireEvent.click(screen.getByTitle(first));
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0]).toContain("hello");
    expect(onChange.mock.calls[0][0]).not.toBe("hello");
  });

  it("switches to Preview by click and by arrow key, and hides the toolbar there", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByText("Nothing to preview")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Write markdown...")).toBeNull();
    const preview = screen.getByRole("tab", { name: "Preview" });
    preview.focus();
    fireEvent.keyDown(preview, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Write" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByPlaceholderText("Write markdown...")).toBeInTheDocument();
  });

  it("previews the markdown", () => {
    render(<Harness initial="# Title" />);
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Title");
  });
});

describe("markdown prose classes (restyle)", () => {
  it("puts code blocks on bg-code and links on the link color", () => {
    expect(MARKDOWN_PROSE_CLASSES).toContain("prose-pre:bg-code");
    expect(MARKDOWN_PROSE_CLASSES).toContain("prose-a:text-link");
    expect(MARKDOWN_PROSE_CLASSES).not.toMatch(/conduit-|bg-well|border-stroke/);
  });
});
