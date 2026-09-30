import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Checkbox, ChoiceCard, ChoiceGroup, Radio, RadioGroup, SegmentedControl, Switch, TabPanel, Tabs } from "..";

afterEach(cleanup);

describe("Checkbox", () => {
  it("is a label wrapping input[type=checkbox] and the text (ui-forms.mjs setCheckbox)", () => {
    const onChange = vi.fn();
    render(
      <Checkbox checked={false} onChange={onChange}>
        Remember this device
      </Checkbox>,
    );
    const label = [...document.querySelectorAll("label")].find((l) => (l.textContent ?? "").includes("Remember this device"));
    const box = label?.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(box).toBeTruthy();
    expect(box.className).toContain("size-[18px]");
    expect(box.className).toContain("rounded-[3px]");
    box.click();
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Radio and RadioGroup", () => {
  it("renders label > input[type=radio] whose label text is exactly the option text", () => {
    const onChange = vi.fn();
    render(
      <RadioGroup aria-label="When both devices changed an entry" value="custom" onChange={onChange}>
        <Radio value="custom">Keep both (recommended)</Radio>
        <Radio value="native">Use this device's version</Radio>
      </RadioGroup>,
    );
    expect(screen.getByRole("radiogroup", { name: "When both devices changed an entry" })).toBeInTheDocument();
    const labels = [...document.querySelectorAll("label")];
    expect(labels.map((l) => (l.textContent ?? "").trim())).toEqual(["Keep both (recommended)", "Use this device's version"]);
    const radios = labels.map((l) => l.querySelector("input[type=radio]") as HTMLInputElement);
    expect(radios[0].checked).toBe(true);
    expect(radios[0].name).toBeTruthy();
    expect(radios[1].name).toBe(radios[0].name);
    radios[1].click();
    expect(onChange).toHaveBeenCalledWith("native");
  });
});

describe("Switch", () => {
  it("is a button with role=switch and aria-checked", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Local Backup" />);
    const sw = screen.getByRole("switch", { name: "Local Backup" });
    expect(sw.tagName).toBe("BUTTON");
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("draws the off track on the checkbox tokens and the on track in the primary color", () => {
    const view = render(<Switch checked={false} onChange={() => {}} label="Off" />);
    const sw = screen.getByRole("switch");
    expect(sw.className).toContain("bg-(--c-checkbox-bg)");
    expect(sw.className).toContain("border-(--c-checkbox-border)");
    view.rerender(<Switch checked onChange={() => {}} label="On" />);
    expect(sw.className).toContain("bg-btn-primary");
    expect(sw.className).toContain("border-transparent");
  });
});

function ControlledSegmented() {
  const [value, setValue] = useState("dark");
  return (
    <SegmentedControl
      aria-label="Mode"
      value={value}
      onChange={setValue}
      options={[
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" },
        { value: "system", label: "System" },
      ]}
    />
  );
}

describe("SegmentedControl", () => {
  it("is a radiogroup of radios with roving focus that arrows move and select", () => {
    render(<ControlledSegmented />);
    expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeInTheDocument();
    const dark = screen.getByRole("radio", { name: "Dark" });
    expect(dark).toHaveAttribute("aria-checked", "true");
    expect(dark).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("tabindex", "-1");

    dark.focus();
    fireEvent.keyDown(dark, { key: "ArrowRight" });
    const light = screen.getByRole("radio", { name: "Light" });
    expect(light).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(light);

    fireEvent.keyDown(light, { key: "End" });
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  });
});

function ControlledChoices() {
  const [value, setValue] = useState("lucide");
  return (
    <ChoiceGroup aria-label="Icon pack" value={value} onChange={setValue} columns={3}>
      <ChoiceCard value="lucide" label="Lucide" description="Clean line icons · ISC" />
      <ChoiceCard value="hugeicons" label="Hugeicons" />
      <ChoiceCard value="tabler" label="Tabler (Classic)" />
    </ChoiceGroup>
  );
}

describe("ChoiceGroup and ChoiceCard", () => {
  it("is a radiogroup whose cards are radios with data-cv-choice and roving focus", () => {
    render(<ControlledChoices />);
    const group = screen.getByRole("radiogroup", { name: "Icon pack" });
    expect(group.className).toContain("grid-cols-3");
    const first = screen.getByRole("radio", { name: /Lucide/ });
    expect(first).toHaveAttribute("data-cv-choice", "lucide");
    expect(first).toHaveAttribute("aria-checked", "true");
    expect(first).toHaveAttribute("tabindex", "0");
    // The checked card sits on bg-selected-inactive, so its muted description is re-scoped (spec 2.11).
    expect(first).toHaveAttribute("data-selected");
    expect(screen.getByRole("radio", { name: /Hugeicons/ })).not.toHaveAttribute("data-selected");

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const hugeicons = screen.getByRole("radio", { name: /Hugeicons/ });
    expect(hugeicons).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(hugeicons);
    fireEvent.keyDown(hugeicons, { key: "ArrowUp" });
    expect(first).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: /Tabler/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(hugeicons);
    expect(hugeicons).toHaveAttribute("aria-checked", "true");
  });
});

function ControlledTabs({ variant }: { variant: "panel" | "underline" }) {
  const [value, setValue] = useState("edit");
  return (
    <>
      <Tabs
        aria-label="Editor mode"
        variant={variant}
        idBase="md"
        value={value}
        onChange={setValue}
        items={[
          { value: "edit", label: "Edit" },
          { value: "preview", label: "Preview" },
          { value: "split", label: "Split" },
        ]}
      />
      <TabPanel idBase="md" value={value}>
        Panel {value}
      </TabPanel>
    </>
  );
}

describe("Tabs", () => {
  it("panel variant: tablist, tabs with aria-selected and aria-controls, arrows and Home/End activate", () => {
    render(<ControlledTabs variant="panel" />);
    const list = screen.getByRole("tablist", { name: "Editor mode" });
    expect(list.className).toContain("h-part-title");
    const edit = screen.getByRole("tab", { name: "Edit" });
    expect(edit).toHaveAttribute("aria-selected", "true");
    expect(edit.className).toContain("bg-selected-inactive");
    expect(edit).toHaveAttribute("aria-controls", "md-panel-edit");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", edit.id);

    edit.focus();
    fireEvent.keyDown(edit, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Panel preview");
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(screen.getByRole("tab", { name: "Split" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Split" })).toHaveAttribute("aria-selected", "true");
  });

  it("underline variant draws the selected tab with the underline token", () => {
    render(<ControlledTabs variant="underline" />);
    const list = screen.getByRole("tablist");
    expect(list.className).toContain("border-b");
    const edit = screen.getByRole("tab", { name: "Edit" });
    expect(edit.className).toContain("border-(--c-tab-underline)");
    expect(screen.getByRole("tab", { name: "Preview" }).className).toContain("border-transparent");
  });
});
