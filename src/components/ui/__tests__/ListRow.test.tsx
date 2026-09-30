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

  it("grows to fit a detail line under the description instead of a fixed height", () => {
    render(
      <ListRow onClick={() => {}} description="admin" detail={<span>#prod</span>}>
        Domain Admin
      </ListRow>,
    );
    const row = screen.getByText("Domain Admin").closest("button") as HTMLButtonElement;
    const cls = row.className.split(" ");
    expect(cls).toEqual(expect.arrayContaining(["h-auto", "py-1"]));
    expect(cls).not.toContain("h-row-2line");
    expect(screen.getByText("admin").nextElementSibling).toHaveTextContent("#prod");
  });

  it("lays trailing actions over the meta with trailingOverlay, so the row keeps its right edge", () => {
    render(
      <ListRow onClick={() => {}} title="row" meta="5m ago" trailingOverlay trailing={<IconButton icon="key" label="Copy password" size="sm" />}>
        web-01
      </ListRow>,
    );
    const wrapper = document.querySelector('button[title="row"]')!.parentElement as HTMLElement;
    expect(wrapper.className.split(" ")).not.toContain("pr-1");
    expect(wrapper.className.split(" ")).toContain("relative");
    const slot = screen.getByRole("button", { name: "Copy password" }).parentElement as HTMLElement;
    expect(slot.className.split(" ")).toEqual(expect.arrayContaining(["absolute", "right-0", "bg-well", "opacity-0"]));
    const meta = screen.getByText("5m ago");
    expect(meta.className).toMatch(/group-hover\/row:opacity-0/);
    expect(meta.className).toMatch(/group-focus-within\/row:opacity-0/);
  });

  it("keeps the separate trailing column without trailingOverlay", () => {
    render(
      <ListRow onClick={() => {}} title="row" meta="SSH" trailing={<IconButton icon="key" label="Copy password" size="sm" />}>
        web-01
      </ListRow>,
    );
    const wrapper = document.querySelector('button[title="row"]')!.parentElement as HTMLElement;
    expect(wrapper.className.split(" ")).toContain("pr-1");
    const slot = screen.getByRole("button", { name: "Copy password" }).parentElement as HTMLElement;
    expect(slot.className).not.toMatch(/absolute/);
    expect(screen.getByText("SSH").className).not.toMatch(/opacity-0/);
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

describe("ListRow meta and leading (spec 4.14, L-23)", () => {
  it("shows meta after the label, inside the clickable button, without hover", () => {
    render(
      <ListRow onClick={() => {}} title="/v/Work.conduit" meta={<span data-testid="badge">Pending</span>} trailing={<IconButton size="sm" icon="chevronRight" label="Open" />}>
        Work
      </ListRow>,
    );
    const button = document.querySelector('button[title="/v/Work.conduit"]') as HTMLElement;
    const badge = screen.getByTestId("badge");
    expect(button.contains(badge)).toBe(true);
    const slot = badge.parentElement as HTMLElement;
    expect(slot.className.split(" ")).toEqual(expect.arrayContaining(["shrink-0", "text-meta", "text-ink-faint"]));
    expect(slot.className).not.toMatch(/opacity-0|group-hover/);
    const label = screen.getByText("Work");
    expect(label.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.contains(screen.getByRole("button", { name: "Open" }))).toBe(false);
  });

  it("renders no meta slot without meta", () => {
    render(<ListRow onClick={() => {}}>Plain</ListRow>);
    expect(document.querySelector(".text-ink-faint")).toBeNull();
  });

  it("draws an icon source in a 16px box and lets an element size itself", () => {
    render(
      <>
        <ListRow leading="folder">Icon</ListRow>
        <ListRow leading={<span data-testid="tile" className="size-7 rounded-md bg-well" />} description="/Users/me">
          Tile
        </ListRow>
      </>,
    );
    const iconBox = screen.getByText("Icon").closest(".h-row")!.firstElementChild as HTMLElement;
    expect(iconBox.className.split(" ")).toContain("size-4");
    const tileSlot = screen.getByTestId("tile").parentElement as HTMLElement;
    expect(tileSlot.className.split(" ")).toContain("shrink-0");
    expect(tileSlot.className.split(" ")).not.toContain("size-4");
  });
});

describe("TreeRow", () => {
  it("is a treeitem with aria-level, aria-expanded on containers and 12px indent per level", () => {
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
    // 4px + 2 levels × 12px; jsdom folds the calc() to calc(28px).
    expect(leaf.style.paddingLeft).toMatch(/^calc\((4px \+ 24px|28px)\)$/);
    expect(folder.style.paddingLeft).toMatch(/^calc\((4px \+ 0px|4px)\)$/);
    expect(folder.querySelector("[data-twistie]")).not.toBeNull();
    expect(leaf.querySelector("[data-twistie]")).not.toBeNull();
    fireEvent.click(folder.querySelector("[data-twistie]") as Element);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
