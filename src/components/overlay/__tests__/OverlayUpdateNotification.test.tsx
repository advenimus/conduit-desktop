import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import OverlayUpdateNotification from "../OverlayUpdateNotification";
import type { UpdateState } from "../../../types/toast";

afterEach(cleanup);

function mount(update: UpdateState) {
  const onAction = vi.fn();
  render(<OverlayUpdateNotification update={update} onAction={onAction} />);
  const card = document.querySelector('[data-toast="update-notification"]') as HTMLElement;
  const buttons = () => [...card.querySelectorAll("button")].map((b) => b.textContent);
  return { card, onAction, buttons };
}

describe("OverlayUpdateNotification", () => {
  it("renders on the ToastCard look with data-toast kept and no colored left bar", () => {
    const { card } = mount({ state: "downloading", version: "2.4.0", progress: 10 });
    expect(card).not.toBeNull();
    expect(card.className).toContain("bg-overlay");
    expect(card.className).toContain("shadow-overlay");
    expect(card.className).toContain("animate-toast-in");
    expect(card.className).not.toMatch(/border-l-/);
  });

  it("while downloading shows the info tone, the version, the progress and no action buttons", () => {
    const { card, buttons } = mount({ state: "downloading", version: "2.4.0", progress: 37 });
    expect(screen.getByText("Update Available").className).toContain("font-semibold");
    expect(screen.getByText("Version 2.4.0 is available.")).toBeInTheDocument();
    expect(screen.getByText("37% downloaded")).toBeInTheDocument();
    expect((card.querySelector("[style]") as HTMLElement).style.width).toBe("37%");
    expect(card.querySelector("svg")?.getAttribute("class")).toContain("text-info");
    expect(buttons()).toEqual([""]);
  });

  it("counts a missing progress as 0%", () => {
    const { card } = mount({ state: "downloading", version: "2.4.0" });
    expect(screen.getByText("0% downloaded")).toBeInTheDocument();
    expect((card.querySelector("[style]") as HTMLElement).style.width).toBe("0%");
  });

  it("when downloaded offers Restart Now, Later and the manual download, in today's order", () => {
    const { card, onAction, buttons } = mount({ state: "downloaded", version: "2.4.0", progress: 100 });
    expect(screen.getByText("Update Ready")).toBeInTheDocument();
    expect(screen.getByText("Version 2.4.0 is ready to install.")).toBeInTheDocument();
    expect(card.querySelector("svg")?.getAttribute("class")).toContain("text-success");
    expect(card.querySelector("[style]")).toBeNull();
    expect(buttons()).toEqual(["Restart Now", "Later", "Download manually from website", ""]);
    expect(screen.getByRole("button", { name: "Restart Now" }).className).toContain("bg-btn-primary");
    expect(screen.getByRole("button", { name: "Later" }).className).toContain("--c-btn-secondary-bg");
    const icons = ["Restart Now", "Later", "Download manually from website"].map((name) => screen.getByRole("button", { name }).querySelector("svg") !== null);
    expect(icons).toEqual([true, false, true]);
    fireEvent.click(screen.getByRole("button", { name: "Restart Now" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    fireEvent.click(screen.getByRole("button", { name: "Download manually from website" }));
    expect(onAction.mock.calls).toEqual([["install"], ["dismiss"], ["website"]]);
  });

  it("on error offers Download from Website and Later", () => {
    const { card, onAction, buttons } = mount({ state: "error", version: "2.4.0" });
    expect(screen.getByText("Update Failed")).toBeInTheDocument();
    expect(screen.getByText("Auto-update failed. You can download the latest version from our website.")).toBeInTheDocument();
    expect(card.querySelector("svg")?.getAttribute("class")).toContain("text-danger");
    expect(buttons()).toEqual(["Download from Website", "Later", ""]);
    expect(screen.getByRole("button", { name: "Download from Website" }).className).toContain("bg-btn-primary");
    expect(screen.getByRole("button", { name: "Download from Website" }).querySelector("svg")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download from Website" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(onAction.mock.calls).toEqual([["website"], ["dismiss"]]);
  });

  it("dismisses through the close button labeled Dismiss", () => {
    const { onAction } = mount({ state: "downloading", version: "2.4.0", progress: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onAction).toHaveBeenCalledWith("dismiss");
  });
});
