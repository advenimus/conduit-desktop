import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import ColorPicker from "../ColorPicker";
import IconPicker from "../IconPicker";
import DefaultableCheckbox from "../DefaultableCheckbox";
import DefaultableSelect from "../DefaultableSelect";
import Field from "../Field";
import { ICON_CATEGORIES } from "../iconRegistry";

function anchor() {
  const ref = createRef<HTMLButtonElement>();
  render(<button ref={ref}>anchor</button>);
  return ref;
}

const pickerPanel = () => document.querySelector("[data-popover]") as HTMLElement;

describe("IconPicker (spec 3.16)", () => {
  it("keeps its 300px card, header, search, Use Default and 6-column grids of 36px cells in the overlay look", () => {
    render(<IconPicker value={null} onSelect={vi.fn()} onClose={vi.fn()} anchorRef={anchor()} />);
    const panel = pickerPanel();
    expect(panel.className).toContain("w-[300px]");
    expect(panel.className).toContain("bg-overlay");
    expect(panel.className).toContain("border-overlay-border");
    expect(panel.className).toContain("shadow-overlay");
    expect(screen.getByText("Icon")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Search icons..."));
    expect(screen.getByRole("button", { name: "Use Default" }).hasAttribute("data-selected")).toBe(true);
    const grids = panel.querySelectorAll(".grid-cols-6");
    expect(grids).toHaveLength(ICON_CATEGORIES.length);
    const cell = screen.getByTitle("Server");
    expect(cell.className).toContain("size-9");
  });

  it("draws the category labels without uppercase and marks the selected cell", () => {
    render(<IconPicker value="IconServer" onSelect={vi.fn()} onClose={vi.fn()} anchorRef={anchor()} />);
    const label = screen.getByText("Connections");
    expect(label.className).not.toMatch(/uppercase|tracking/);
    const cell = screen.getByTitle("Server");
    expect(cell.hasAttribute("data-selected")).toBe(true);
    expect(cell.className).toContain("bg-selected");
    expect(screen.getByRole("button", { name: "Use Default" }).hasAttribute("data-selected")).toBe(false);
  });

  it("filters by name and picks an icon", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<IconPicker value={null} onSelect={onSelect} onClose={onClose} anchorRef={anchor()} />);
    fireEvent.change(screen.getByPlaceholderText("Search icons..."), { target: { value: "docker" } });
    expect(pickerPanel().querySelectorAll(".grid-cols-6 button")).toHaveLength(1);
    fireEvent.click(screen.getByTitle("BrandDocker"));
    expect(onSelect).toHaveBeenCalledWith("IconBrandDocker");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ColorPicker (spec 3.16)", () => {
  it("keeps its 220px card, Use Default and 8-column grid of 16 swatches; the selected swatch has the accent ring", () => {
    const onSelect = vi.fn();
    render(<ColorPicker value="#22c55e" onSelect={onSelect} onClose={vi.fn()} anchorRef={anchor()} />);
    const panel = pickerPanel();
    expect(panel.className).toContain("w-[220px]");
    expect(panel.className).toContain("bg-overlay");
    const swatches = panel.querySelectorAll(".grid-cols-8 button");
    expect(swatches).toHaveLength(16);
    const selected = screen.getByTitle("#22c55e");
    expect(selected.className).toContain("ring-(--c-accent)");
    expect(selected.className).toContain("ring-offset-(--c-overlay)");
    fireEvent.click(screen.getByRole("button", { name: "Use Default" }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe("entry field helpers", () => {
  it("Field wraps a single control in its label and marks required fields", () => {
    render(
      <Field label="Name" required>
        <input />
      </Field>,
    );
    const label = document.querySelector("label") as HTMLLabelElement;
    expect(label.querySelector("span")?.textContent).toBe("Name*");
    expect(label.querySelector("input")).not.toBeNull();
  });

  it("Field in group mode puts the label above composite content", () => {
    render(
      <Field label="Appearance" group>
        <button type="button">Default</button>
      </Field>,
    );
    const label = document.querySelector("label") as HTMLLabelElement;
    expect(label.textContent).toBe("Appearance");
    expect(label.querySelector("button")).toBeNull();
    expect(screen.getByRole("group", { name: "Appearance" })).toBeTruthy();
  });

  it("DefaultableSelect maps its Default option to undefined", () => {
    const onChange = vi.fn();
    render(
      <DefaultableSelect<string> value="best" defaultLabel="Good" options={[{ value: "best", label: "Best" }, { value: "good", label: "Good" }]} onChange={onChange} />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Default (Good)", "Best", "Good"]);
    fireEvent.change(select, { target: { value: "__default__" } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("DefaultableCheckbox keeps its text beside a named Default / On / Off select", () => {
    const onChange = vi.fn();
    render(<DefaultableCheckbox value={undefined} defaultValue={false} label="High DPI (Retina)" onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "High DPI (Retina)" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Default (Off)", "On", "Off"]);
    expect(document.querySelector("label")).toBeNull();
    fireEvent.change(select, { target: { value: "on" } });
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
