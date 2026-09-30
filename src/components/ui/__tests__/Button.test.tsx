import { describe, it, expect, vi, afterEach } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Button, IconButton } from "..";
import { SettingsIcon } from "../../../lib/icons";

afterEach(cleanup);

describe("Button", () => {
  it("is a type=button text button by default and forwards ref, data-* and className", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button ref={ref} data-cv-hook="x" className="last-class">
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("data-cv-text-button");
    expect(button).toHaveAttribute("data-cv-hook", "x");
    expect(button.className.endsWith("last-class")).toBe(true);
    expect(ref.current).toBe(button);
  });

  it("keeps a visible label while loading: loadingLabel when given, else the children", () => {
    const view = render(
      <Button loading loadingLabel="Opening..." icon="folder">
        Open
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("Opening...");
    expect(button).toBeVisible();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    expect(button.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");

    view.rerender(<Button loading>Checking...</Button>);
    expect(screen.getByRole("button")).toHaveTextContent("Checking...");
  });

  it("draws the loader at the icon size: 16px, 12px in sm (spec 4.2)", () => {
    const view = render(<Button loading>Saving</Button>);
    expect(screen.getByRole("button").querySelector("svg")).toHaveAttribute("width", "16");
    view.rerender(
      <Button loading size="sm">
        Saving
      </Button>,
    );
    expect(screen.getByRole("button").querySelector("svg")).toHaveAttribute("width", "12");
  });

  it("does not fire onClick while loading or disabled", () => {
    const onClick = vi.fn();
    const view = render(
      <Button loading onClick={onClick}>
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole("button"));
    view.rerender(
      <Button disabled onClick={onClick}>
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders a leading and a trailing icon from a semantic name or a component", () => {
    render(
      <Button icon="plus" iconEnd={SettingsIcon}>
        Add
      </Button>,
    );
    expect(screen.getByRole("button").querySelectorAll("svg")).toHaveLength(2);
  });

  it("maps each variant to its token classes", () => {
    render(
      <>
        <Button variant="primary">P</Button>
        <Button variant="secondary">S</Button>
        <Button variant="ghost">G</Button>
        <Button variant="danger">D</Button>
        <Button variant="link">L</Button>
        <Button variant="ghost-danger">GD</Button>
      </>,
    );
    expect(screen.getByText("P").className).toContain("bg-btn-primary");
    expect(screen.getByText("S").className).toContain("bg-(--c-btn-secondary-bg)");
    expect(screen.getByText("G").className).toContain("hover:bg-hover");
    expect(screen.getByText("D").className).toContain("bg-btn-danger");
    expect(screen.getByText("L").className).toContain("text-link");
    expect(screen.getByText("L").className).not.toContain("h-control");
    const ghostDanger = screen.getByText("GD").className.split(" ");
    expect(ghostDanger).toEqual(expect.arrayContaining(["bg-transparent", "text-danger", "hover:bg-hover"]));
    expect(ghostDanger).not.toContain("text-ink-secondary");
  });

  it("sizes: sm 22px with 11px text, md 26px, lg 32px, fullWidth", () => {
    render(
      <>
        <Button size="sm">Small</Button>
        <Button>Medium</Button>
        <Button size="lg" fullWidth>
          Large
        </Button>
      </>,
    );
    expect(screen.getByText("Small").className).toContain("h-control-sm");
    expect(screen.getByText("Small").className).toContain("text-meta");
    expect(screen.getByText("Medium").className).toContain("h-control ");
    expect(screen.getByText("Large").className).toContain("h-control-lg");
    expect(screen.getByText("Large").className).toContain("w-full");
  });
});

describe("IconButton", () => {
  it("uses the label as aria-label and native title", () => {
    render(<IconButton icon="close" label="Close tab (Ctrl+W)" />);
    const button = screen.getByRole("button", { name: "Close tab (Ctrl+W)" });
    expect(button).toHaveAttribute("title", "Close tab (Ctrl+W)");
    expect(button).toHaveAttribute("type", "button");
    expect(button).not.toHaveAttribute("data-cv-text-button");
  });

  it("has a 4px radius at every size", () => {
    render(
      <>
        <IconButton icon="close" label="sm" size="sm" />
        <IconButton icon="close" label="md" />
        <IconButton icon="close" label="lg" size="lg" />
      </>,
    );
    for (const name of ["sm", "md", "lg"]) {
      const cls = screen.getByRole("button", { name }).className.split(" ");
      expect(cls).toContain("rounded");
      expect(cls.some((c) => /^rounded-(md|lg|xl|full)$/.test(c))).toBe(false);
    }
    expect(screen.getByRole("button", { name: "sm" }).className).toContain("size-5");
    expect(screen.getByRole("button", { name: "md" }).className).toContain("size-toolbar");
    expect(screen.getByRole("button", { name: "lg" }).className).toContain("size-7");
  });

  it("pressed sets aria-pressed and the pressed look", () => {
    const view = render(<IconButton icon="robot" label="Toggle AI Panel" pressed />);
    const button = screen.getByRole("button", { name: "Toggle AI Panel" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button.className.split(" ")).toEqual(expect.arrayContaining(["bg-toolbar-active", "text-ink"]));

    view.rerender(<IconButton icon="robot" label="Toggle AI Panel" pressed={false} />);
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button.className).not.toMatch(/(^| )bg-toolbar-active/);
  });

  it("has no pressedLook prop any more: every pressed button shows the pressed look", () => {
    // @ts-expect-error pressedLook was removed with the glyph-swap buttons (spec 4.3)
    render(<IconButton icon="pin" label="Pin" pressed pressedLook={false} />);
    expect(screen.getByRole("button", { name: "Pin" }).className).toContain("bg-toolbar-active");
  });

  it('tone="inherit" sets no text color, so the glyph takes the color around it, and keeps the hover fill', () => {
    render(
      <>
        <IconButton icon="close" label="Close web-01" size="sm" tone="inherit" className="cv-tab-close" />
        <IconButton icon="robot" label="Pressed inherit" tone="inherit" pressed />
      </>,
    );
    for (const name of ["Close web-01", "Pressed inherit"]) {
      const classes = screen.getByRole("button", { name }).className.split(" ");
      expect(classes.filter((c) => /(^|:)text-/.test(c)), name).toEqual([]);
    }
    const close = screen.getByRole("button", { name: "Close web-01" }).className.split(" ");
    expect(close).toEqual(expect.arrayContaining(["size-5", "cv-tab-close", "enabled:hover:bg-toolbar-hover"]));
    expect(screen.getByRole("button", { name: "Pressed inherit" }).className).toContain("bg-toolbar-active");
  });

  it("explains why it is disabled in its title", () => {
    render(<IconButton icon="plus" label="New entry" disabled disabledReason="View-only access" />);
    const button = screen.getByRole("button", { name: "New entry" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "View-only access");
  });

  it("tone=danger turns the hover color to danger", () => {
    render(<IconButton icon="trash" label="Delete" tone="danger" />);
    expect(screen.getByRole("button", { name: "Delete" }).className).toContain("hover:text-danger");
  });
});
