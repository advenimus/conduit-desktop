import { describe, it, expect, vi, afterEach } from "vitest";
import { useRef, useState } from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { Dialog, Menu, MenuHeader, MenuItem, MenuSeparator, Popover } from "..";
import { freezeHolders, isFrozen } from "../../../lib/native-freeze";

afterEach(() => {
  cleanup();
  expect(freezeHolders()).toEqual([]);
});

function VaultMenu({ onLock = () => {}, freeze = "auto" as const }: { onLock?: () => void; freeze?: "auto" | true | false }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen((o) => !o)}>
        Vaults
      </button>
      <button type="button">Elsewhere</button>
      <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} freeze={freeze} data-context-menu="">
        <Menu aria-label="Vault menu" onClose={() => setOpen(false)}>
          <MenuHeader>Recent</MenuHeader>
          <MenuItem icon="lock" onSelect={onLock}>
            Lock Current Vault
          </MenuItem>
          <MenuItem icon="plus" onSelect={() => {}}>
            New Vault
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon="trash" danger onSelect={() => {}}>
            Delete
          </MenuItem>
          <MenuItem onSelect={() => {}} disabled>
            Disabled item
          </MenuItem>
        </Menu>
      </Popover>
    </>
  );
}

function open() {
  fireEvent.click(screen.getByText("Vaults"));
}

describe("Menu", () => {
  it("items are button[role=menuitem] inside role=menu; the separator and header are not items", () => {
    render(<VaultMenu />);
    open();
    expect(screen.getByRole("menu", { name: "Vault menu" })).toBeInTheDocument();
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON", "BUTTON"]);
    expect(items.every((i) => i.getAttribute("type") === "button")).toBe(true);
    expect(document.querySelector("[role=separator]")).not.toBeNull();
    expect(screen.getByText("Recent").closest("[role=menuitem]")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain("text-danger");
    expect(document.querySelector("[data-context-menu]")).not.toBeNull();
  });

  it("the harness can click Lock Current Vault with selector button (B43)", () => {
    const onLock = vi.fn();
    render(<VaultMenu onLock={onLock} />);
    open();
    const target = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Lock Current Vault");
    fireEvent.click(target as HTMLButtonElement);
    expect(onLock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("focuses the first item on open; Up, Down, Home, End and typeahead move between enabled items", () => {
    render(<VaultMenu />);
    open();
    const [lock, newVault, del] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(lock);
    fireEvent.keyDown(lock, { key: "ArrowDown" });
    expect(document.activeElement).toBe(newVault);
    fireEvent.keyDown(newVault, { key: "End" });
    expect(document.activeElement).toBe(del);
    fireEvent.keyDown(del, { key: "ArrowDown" });
    expect(document.activeElement).toBe(lock);
    fireEvent.keyDown(lock, { key: "ArrowUp" });
    expect(document.activeElement).toBe(del);
    fireEvent.keyDown(del, { key: "Home" });
    expect(document.activeElement).toBe(lock);
    fireEvent.keyDown(lock, { key: "n" });
    expect(document.activeElement).toBe(newVault);
  });

  it("leaves keys typed into a field inside the menu alone (a custom model id input)", () => {
    render(
      <Menu aria-label="Models" autoFocus={false}>
        <MenuItem onSelect={() => {}}>Claude Opus</MenuItem>
        <MenuItem onSelect={() => {}}>Claude Sonnet</MenuItem>
        <input aria-label="Custom model" />
        <textarea aria-label="Notes" />
      </Menu>,
    );
    for (const field of [screen.getByRole("textbox", { name: "Custom model" }), screen.getByRole("textbox", { name: "Notes" })]) {
      field.focus();
      for (const key of ["a", "c", "Home", "End", "ArrowUp", "ArrowDown"]) {
        expect(fireEvent.keyDown(field, { key }), key).toBe(true);
        expect(document.activeElement, key).toBe(field);
      }
    }
  });

  it("Escape closes the menu only and returns focus to the anchor, even inside a dialog", () => {
    const onDialogClose = vi.fn();
    render(
      <Dialog open onClose={onDialogClose} title="Host">
        <VaultMenu />
      </Dialog>,
    );
    open();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onDialogClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByText("Vaults"));
  });

  it("closes on a mousedown outside the popover and its anchor", () => {
    render(<VaultMenu />);
    open();
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "New Vault" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("Elsewhere"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Popover", () => {
  it("renders in a portal on the popover layer with the overlay look", () => {
    render(<VaultMenu />);
    open();
    const panel = screen.getByRole("menu").parentElement as HTMLElement;
    expect(panel.parentElement).toBe(document.body);
    expect(panel.className).toContain("z-(--c-z-popover)");
    expect(panel.className).toContain("bg-overlay");
    expect(panel.className).toContain("rounded-lg");
  });

  it('freeze={true} holds a popover freeze while open; "auto" does not without an editor card under it', async () => {
    const a = render(<VaultMenu freeze />);
    open();
    expect(isFrozen()).toBe(true);
    expect(freezeHolders()).toEqual([expect.objectContaining({ reason: "popover" })]);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await act(async () => {});
    // The panel still paints while cv-pop-out plays, so the web view stays hidden until it unmounts.
    const exiting = document.querySelector("[data-context-menu]") as HTMLElement;
    expect(exiting).not.toBeNull();
    expect(isFrozen()).toBe(true);
    // jsdom plays no animation, so the exit ends on the fallback timer.
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(document.querySelector("[data-context-menu]")).toBeNull();
    expect(isFrozen()).toBe(false);
    a.unmount();

    render(<VaultMenu />);
    open();
    expect(isFrozen()).toBe(false);
  });
});
