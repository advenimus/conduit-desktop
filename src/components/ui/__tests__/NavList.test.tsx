import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NavList, type NavEntry } from "..";

afterEach(cleanup);

const ITEMS: ReadonlyArray<NavEntry> = [
  { kind: "label", id: "general-label", label: "General" },
  { id: "general", label: "General settings", icon: "settings" },
  { id: "appearance", label: "Appearance", icon: "palette" },
  {
    kind: "group",
    id: "sessions",
    label: "Sessions",
    icon: "terminal",
    children: [
      { id: "sessions/ssh", label: "SSH", icon: "key" },
      { id: "sessions/rdp", label: "RDP", icon: "desktop" },
    ],
  },
  { id: "backup", label: "Backup", icon: "floppy" },
];

function Controlled({ initial = "general" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <NavList aria-label="Settings" items={ITEMS} value={value} onChange={setValue} className="w-52" data-cv-settings-nav="" />;
}

describe("NavList", () => {
  it("is a navigation of buttons; the current one has aria-current=page and data-selected", () => {
    render(<Controlled />);
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(nav).toHaveAttribute("data-cv-settings-nav");
    expect(nav.className).toContain("w-52");
    const current = screen.getByRole("button", { name: "General settings" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveAttribute("data-selected");
    expect(current.className).toContain("bg-selected");
    expect(screen.getByRole("button", { name: "Appearance" })).not.toHaveAttribute("aria-current");
    expect(screen.getByText("General").tagName).not.toBe("BUTTON");
  });

  it("clicking an item selects it", () => {
    render(<Controlled />);
    fireEvent.click(screen.getByRole("button", { name: "Backup" }));
    expect(screen.getByRole("button", { name: "Backup" })).toHaveAttribute("aria-current", "page");
  });

  it("group rows expand and collapse and show their children", () => {
    render(<Controlled />);
    const group = screen.getByRole("button", { name: "Sessions" });
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "SSH" })).toBeNull();
    fireEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    expect(screen.getByRole("button", { name: "SSH" })).toHaveAttribute("aria-current", "page");
  });

  it("a collapsed group with the current child looks selected", () => {
    render(<Controlled initial="sessions/rdp" />);
    expect(screen.getByRole("button", { name: "Sessions" })).toHaveAttribute("data-selected");
  });

  it("Up, Down, Home and End move focus between rows; Right and Left open and close a group", () => {
    render(<Controlled />);
    const general = screen.getByRole("button", { name: "General settings" });
    general.focus();
    fireEvent.keyDown(general, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Appearance" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    const group = screen.getByRole("button", { name: "Sessions" });
    expect(document.activeElement).toBe(group);
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(group).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "SSH" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(group);
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(group).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(group, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Backup" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(document.activeElement).toBe(general);
    fireEvent.keyDown(general, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Backup" }));
  });
});
