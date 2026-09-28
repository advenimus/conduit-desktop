import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { IconButton, ListRow, TreeRow } from "..";

afterEach(cleanup);

describe("ListRow", () => {
  it("is a button when clickable, so the harness finds button[title=path] (B44)", () => {
    const onClick = vi.fn();
    render(
      <ListRow onClick={onClick} title="/Users/me/Work.conduit" leading="folder" description="/Users/me">
        Work
      </ListRow>,
    );
    const row = document.querySelector('button[title="/Users/me/Work.conduit"]') as HTMLButtonElement;
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("type", "button");
    expect(row.className).toContain("h-row-2line");
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is a div when not clickable, 22px tall without a description", () => {
    render(<ListRow>Static</ListRow>);
    const row = screen.getByText("Static").closest(".h-row");
    expect(row?.tagName).toBe("DIV");
  });

  it("hides trailing actions with opacity only and never nests buttons", () => {
    render(
      <ListRow onClick={() => {}} title="row" trailing={<IconButton icon="trash" label="Remove" size="sm" />}>
        With actions
      </ListRow>,
    );
    const action = screen.getByRole("button", { name: "Remove" });
    const slot = action.parentElement as HTMLElement;
    expect(slot.className).toContain("opacity-0");
    expect(slot.className).toMatch(/group-hover\/row:opacity-100/);
    expect(slot.className).toMatch(/group-focus-within\/row:opacity-100/);
    for (const el of [slot, action]) {
      expect(el.className).not.toMatch(/(^| )(invisible|hidden)( |$)/);
      expect(el.getAttribute("style") ?? "").not.toMatch(/visibility|display/);
    }
    expect(action.closest("button[title=row]")).toBeNull();
    expect(document.querySelector('button[title="row"]')).not.toBeNull();
  });

  it("marks selection with data-selected, or aria-selected inside a listbox", () => {
    render(
      <>
        <ListRow selected>Plain</ListRow>
        <ListRow role="option" selected>
          Option
        </ListRow>
        <ListRow selected inactive>
          Unfocused
        </ListRow>
      </>,
    );
    const plain = screen.getByText("Plain").closest("[data-selected]") as HTMLElement;
    expect(plain).not.toBeNull();
    expect(plain.className).toContain("bg-selected");
    expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "true");
    expect((screen.getByText("Unfocused").closest("[data-selected]") as HTMLElement).className).toContain("bg-selected-inactive");
  });

  it("a selected row with role=tab keeps aria-selected and adds data-selected, since tabs are not re-scoped by role", () => {
    render(
      <ListRow role="tab" selected>
        Tab row
      </ListRow>,
    );
    const tab = screen.getByRole("tab");
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveAttribute("data-selected");
  });
});

describe("TreeRow", () => {
  it("is a treeitem with aria-level, aria-expanded on containers and 8px indent per level", () => {
    const onToggle = vi.fn();
    render(
      <div role="tree" aria-label="Entries">
        <TreeRow depth={0} expanded onToggle={onToggle} leading="folder">
          Servers
        </TreeRow>
        <TreeRow depth={2} leading="terminal" selected>
          web-01
        </TreeRow>
      </div>,
    );
    const [folder, leaf] = screen.getAllByRole("treeitem");
    expect(folder).toHaveAttribute("aria-level", "1");
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(leaf).toHaveAttribute("aria-level", "3");
    expect(leaf).not.toHaveAttribute("aria-expanded");
    expect(leaf).toHaveAttribute("aria-selected", "true");
    // 4px + 2 levels × 8px; jsdom folds the calc() to calc(20px).
    expect(leaf.style.paddingLeft).toMatch(/^calc\((4px \+ 16px|20px)\)$/);
    expect(folder.style.paddingLeft).toMatch(/^calc\((4px \+ 0px|4px)\)$/);
    expect(folder.querySelector("[data-twistie]")).not.toBeNull();
    expect(leaf.querySelector("[data-twistie]")).not.toBeNull();
    fireEvent.click(folder.querySelector("[data-twistie]") as Element);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
