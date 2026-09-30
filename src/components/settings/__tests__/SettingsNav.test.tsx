import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SettingsNav from "../SettingsNav";

const TOP_LEVEL = ["General", "Appearance", "Security", "Sessions", "AI", "Backup", "Sync", "Mobile", "Team", "Account"];

function nav(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-cv-settings-nav]");
  if (!el) throw new Error("no settings nav");
  return el;
}

describe("SettingsNav on NavList (spec 3.12, 4.7, B2)", () => {
  it("keeps w-52, carries the harness hook and lists today's rows with Sessions closed", () => {
    render(<SettingsNav activeTab="general" onTabChange={vi.fn()} />);
    expect(nav().className).toContain("w-52");
    expect(nav()).not.toHaveAttribute("aria-label");
    expect(within(nav()).getAllByRole("button").map((b) => b.textContent)).toEqual(TOP_LEVEL);
    expect(within(nav()).getByRole("button", { name: "Sessions" })).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the Sessions group in place, then selects a child", () => {
    const onTabChange = vi.fn();
    const { rerender } = render(<SettingsNav activeTab="general" onTabChange={onTabChange} />);
    fireEvent.click(within(nav()).getByRole("button", { name: "Sessions" }));
    const labels = within(nav()).getAllByRole("button").map((b) => b.textContent);
    expect(labels.slice(3, 9)).toEqual(["Sessions", "Terminal", "SSH", "RDP", "VNC", "Web"]);
    expect(onTabChange).not.toHaveBeenCalled();

    fireEvent.click(within(nav()).getByRole("button", { name: "RDP" }));
    expect(onTabChange).toHaveBeenCalledWith("sessions/rdp");
    rerender(<SettingsNav activeTab="sessions/rdp" onTabChange={onTabChange} />);
    const rdp = within(nav()).getByRole("button", { name: "RDP" });
    expect(rdp).toHaveAttribute("data-selected");
    expect(rdp).toHaveAttribute("aria-current", "page");
    expect(rdp.className).toContain("bg-selected");
  });

  it("maps AI to its ai/agent tab and marks only the current row", () => {
    const onTabChange = vi.fn();
    render(<SettingsNav activeTab="backup" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole("button", { name: "AI" }));
    expect(onTabChange).toHaveBeenCalledWith("ai/agent");
    expect(nav().querySelectorAll("[data-selected]")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Backup" })).toHaveAttribute("data-selected");
  });
});
