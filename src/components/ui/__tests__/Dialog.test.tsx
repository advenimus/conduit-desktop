import { describe, it, expect, vi, afterEach } from "vitest";
import { StrictMode, useRef, useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader } from "..";
import { freezeHolders, isFrozen } from "../../../lib/native-freeze";

afterEach(() => {
  cleanup();
  expect(freezeHolders()).toEqual([]);
});

function panel(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-dialog-content]");
  if (!el) throw new Error("no dialog panel");
  return el;
}

describe("Dialog markup (harness contract)", () => {
  it("renders a labelled role=dialog panel with an h2 title and the footer as its last child", () => {
    render(
      <Dialog open onClose={() => {}} title="Rename vault" footer={<Button>Cancel</Button>}>
        <p>Body text</p>
      </Dialog>,
    );
    const el = panel();
    expect(el).toHaveAttribute("role", "dialog");
    expect(el).toHaveAttribute("aria-modal", "true");
    const title = el.querySelector("h2");
    expect(title).toHaveTextContent("Rename vault");
    expect(el).toHaveAttribute("aria-labelledby", title?.id);
    expect(el).not.toHaveAttribute("aria-label");
    const footer = el.lastElementChild;
    expect(footer).toHaveAttribute("data-cv-dialog-footer");
    expect(footer?.tagName).toBe("DIV");
    expect(el.querySelector(":scope > div:last-child button")).toHaveTextContent("Cancel");
  });

  it("sets aria-label only when harnessLabel is passed", () => {
    render(<Dialog open onClose={() => {}} title="Review changes" harnessLabel="Review changes" />);
    expect(document.querySelector('[role=dialog][aria-label="Review changes"]')).toBe(panel());
  });

  it("puts data-cv-layer and the layer's z-index on the scrim", () => {
    render(<Dialog open onClose={() => {}} title="Recently deleted" layer="stacked" />);
    const scrim = panel().parentElement as HTMLElement;
    expect(scrim).toHaveAttribute("data-cv-layer", "stacked");
    expect(scrim.className).toContain("z-(--c-z-dialog-stacked)");
  });

  it("portals to document.body by default and renders in place with portal={false}", () => {
    const { container, rerender } = render(
      <div data-testid="host">
        <Dialog open onClose={() => {}} title="Portal" />
      </div>,
    );
    expect(container.querySelector("[data-dialog-content]")).toBeNull();
    expect(document.body.querySelector("[data-dialog-content]")).not.toBeNull();

    rerender(
      <div data-testid="host">
        <Dialog open onClose={() => {}} title="In place" portal={false} />
      </div>,
    );
    expect(screen.getByTestId("host").querySelector("[data-dialog-content]")).not.toBeNull();
  });

  it("forwards data-* hooks and className to the panel", () => {
    render(<Dialog open onClose={() => {}} title="Settings" data-cv-settings="" className="extra-class" />);
    expect(panel()).toHaveAttribute("data-cv-settings");
    expect(panel().className.endsWith("extra-class")).toBe(true);
  });

  it("renders nothing and holds no freeze while closed", () => {
    render(<Dialog open={false} onClose={() => {}} title="Closed" />);
    expect(document.querySelector("[data-dialog-content]")).toBeNull();
    expect(isFrozen()).toBe(false);
  });
});

describe("Dialog with onSubmit", () => {
  it("wraps header, body and footer in one form so the submit button is inside it", () => {
    const onSubmit = vi.fn();
    render(
      <Dialog
        open
        onClose={() => {}}
        title="Unlock"
        onSubmit={onSubmit}
        footer={
          <>
            <Button>Cancel</Button>
            <Button type="submit" variant="primary">
              Unlock
            </Button>
          </>
        }
      >
        <input aria-label="Password" />
      </Dialog>,
    );
    const el = panel();
    expect(el.children).toHaveLength(1);
    const form = el.firstElementChild as HTMLFormElement;
    expect(form.tagName).toBe("FORM");
    expect(form).toHaveAttribute("data-cv-dialog-form");
    expect(form.querySelector("h2")).toHaveTextContent("Unlock");
    expect(form.lastElementChild).toHaveAttribute("data-cv-dialog-footer");

    const submit = document.querySelector<HTMLButtonElement>("[data-dialog-content] form button[type=submit]");
    expect(submit).toHaveTextContent("Unlock");
    expect(submit).toBeVisible();

    fireEvent.click(submit as HTMLButtonElement);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].defaultPrevented).toBe(true);
  });
});

describe("Dialog behavior", () => {
  it("holds a dialog freeze while mounted", () => {
    const view = render(<Dialog open onClose={() => {}} title="Frozen" />);
    expect(isFrozen()).toBe(true);
    expect(freezeHolders()).toEqual([expect.objectContaining({ reason: "dialog", label: "Frozen" })]);
    view.unmount();
    expect(isFrozen()).toBe(false);
  });

  it("closes on Escape through the layer stack, only the top dialog", () => {
    const under = vi.fn();
    const over = vi.fn();
    render(
      <>
        <Dialog open onClose={under} title="Settings" />
        <Dialog open onClose={over} title="Confirm" layer="stacked" />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(over).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();
  });

  it("the close button is labelled Close and calls onClose; hideClose removes it", () => {
    const onClose = vi.fn();
    const view = render(<Dialog open onClose={onClose} title="Closable" />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<Dialog open onClose={onClose} title="Closable" hideClose />);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("closes on a scrim click only with closeOnScrim", () => {
    const onClose = vi.fn();
    const view = render(<Dialog open onClose={onClose} title="About" />);
    const scrim = () => panel().parentElement as HTMLElement;
    fireEvent.mouseDown(scrim());
    fireEvent.click(scrim());
    expect(onClose).not.toHaveBeenCalled();

    view.rerender(<Dialog open onClose={onClose} title="About" closeOnScrim />);
    fireEvent.mouseDown(panel());
    fireEvent.click(scrim());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(scrim());
    fireEvent.click(scrim());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focuses initialFocusRef, else an autofocused control, else the panel", () => {
    function WithRef() {
      const ref = useRef<HTMLInputElement>(null);
      return (
        <Dialog open onClose={() => {}} title="Ref" initialFocusRef={ref}>
          <input aria-label="first" />
          <input aria-label="target" ref={ref} />
        </Dialog>
      );
    }
    const a = render(<WithRef />);
    expect(document.activeElement).toBe(screen.getByLabelText("target"));
    a.unmount();

    const b = render(
      <Dialog open onClose={() => {}} title="Auto">
        <input aria-label="plain" />
        <input aria-label="auto" autoFocus />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("auto"));
    b.unmount();

    render(<Dialog open onClose={() => {}} title="Panel" hideClose />);
    expect(document.activeElement).toBe(panel());
  });

  it("returns focus to the opener when it closes", () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Opened" />
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByText("Open");
    opener.focus();
    fireEvent.click(opener);
    expect(panel().contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(document.querySelector("[data-dialog-content]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps an autofocused field focused under StrictMode and still returns focus on close", () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Strict">
            <input aria-label="field" autoFocus />
          </Dialog>
        </>
      );
    }
    render(
      <StrictMode>
        <Opener />
      </StrictMode>,
    );
    const opener = screen.getByText("Open");
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText("field"));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
  });

  it("traps Tab inside the panel", () => {
    render(
      <Dialog open onClose={() => {}} title="Trap" footer={<Button>Done</Button>}>
        <input aria-label="field" />
      </Dialog>,
    );
    const done = screen.getByText("Done");
    done.focus();
    fireEvent.keyDown(done, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });
});

describe("Dialog custom layout", () => {
  it("renders DialogHeader, DialogBody and DialogFooter from the children", () => {
    render(
      <Dialog open onClose={() => {}} title="Settings" layout="custom">
        <DialogHeader />
        <DialogBody>
          <p>Custom body</p>
        </DialogBody>
        <DialogFooter>
          <Button>Save</Button>
        </DialogFooter>
      </Dialog>,
    );
    const el = panel();
    const title = el.querySelector("h2");
    expect(title).toHaveTextContent("Settings");
    expect(el).toHaveAttribute("aria-labelledby", title?.id);
    expect(el.lastElementChild).toHaveAttribute("data-cv-dialog-footer");
    expect(screen.getByText("Custom body")).toBeInTheDocument();
    expect(el.querySelectorAll(`[id="${title?.id}"]`)).toHaveLength(1);
  });

  it("still has an accessible name without a DialogHeader, and no aria-label (the harness reads that as a sync dialog)", () => {
    render(
      <Dialog open onClose={() => {}} title="Pick an icon" layout="custom">
        <DialogBody>
          <p>Icons</p>
        </DialogBody>
        <DialogFooter>
          <Button>Done</Button>
        </DialogFooter>
      </Dialog>,
    );
    const el = panel();
    expect(screen.getByRole("dialog", { name: "Pick an icon" })).toBe(el);
    expect(el).not.toHaveAttribute("aria-label");
    expect(document.getElementById(el.getAttribute("aria-labelledby") ?? "")).not.toBeNull();
    expect(el.lastElementChild).toHaveAttribute("data-cv-dialog-footer");
  });
});

describe("Dialog width and close behavior (spec 4.8, D-18, D-26)", () => {
  it("width overrides the size step with an inline max-width, so a dialog keeps today's width", () => {
    const { rerender } = render(<Dialog open onClose={() => {}} title="Settings" width={768} />);
    expect(panel().style.maxWidth).toBe("768px");
    expect(panel().className).not.toMatch(/max-w-\[/);

    rerender(<Dialog open onClose={() => {}} title="Settings" size="sm" />);
    expect(panel().style.maxWidth).toBe("");
    expect(panel().className).toContain("max-w-[400px]");

    rerender(<Dialog open onClose={() => {}} title="Settings" width={448} style={{ minHeight: 10 }} />);
    expect(panel().style.maxWidth).toBe("448px");
    expect(panel().style.minHeight).toBe("10px");
  });

  it("closeOnEscape={false}: Escape does not call onClose, and the layer still swallows it", () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") outer();
    };
    document.addEventListener("keydown", onKey);
    render(<Dialog open onClose={onClose} title="New Entry" closeOnEscape={false} />);
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener("keydown", onKey);
  });

  it("closeOnEscape defaults to true", () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Quick Connect" />);
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a dialog that cannot be dismissed takes no onClose, no close button, no Escape and no scrim close", () => {
    render(
      <Dialog open title="Save Your Recovery Passphrase" hideClose closeOnEscape={false}>
        <p>Write it down.</p>
      </Dialog>,
    );
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.keyDown(panel(), { key: "Escape" });
    const scrim = panel().parentElement as HTMLElement;
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(document.querySelector("[data-dialog-content]")).not.toBeNull();
  });

  it("makes a missing onClose a type error unless the dialog is undismissable", () => {
    // @ts-expect-error onClose is required while the dialog shows a close button
    const a = <Dialog open title="No close handler" closeOnEscape={false} />;
    // @ts-expect-error onClose is required while Escape closes the dialog
    const b = <Dialog open title="No close handler" hideClose />;
    // @ts-expect-error an undismissable dialog cannot close on a scrim click
    const c = <Dialog open title="No close handler" hideClose closeOnEscape={false} closeOnScrim />;
    const ok = <Dialog open title="Undismissable" hideClose closeOnEscape={false} />;
    expect([a, b, c, ok]).toHaveLength(4);
  });
});
