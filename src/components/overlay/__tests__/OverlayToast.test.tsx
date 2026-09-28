import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import OverlayToast from "../OverlayToast";
import type { SerializedToast } from "../../../types/toast";

afterEach(cleanup);

function mount(toast: SerializedToast) {
  const onDismiss = vi.fn();
  const onAction = vi.fn();
  render(<OverlayToast toast={toast} onDismiss={onDismiss} onAction={onAction} />);
  const card = document.querySelector(`[data-toast="${toast.id}"]`) as HTMLElement;
  return { card, onDismiss, onAction };
}

const TONES: ReadonlyArray<[SerializedToast["type"], string]> = [
  ["success", "text-success"],
  ["info", "text-info"],
  ["warning", "text-warning"],
  ["error", "text-danger"],
];

describe("OverlayToast", () => {
  it.each(TONES)("%s renders the ToastCard look with its tone icon and no colored left bar", (type, color) => {
    const { card } = mount({ id: `t-${type}`, type, title: "Username copied" });
    expect(card).not.toBeNull();
    expect(card.className).toContain("rounded-lg");
    expect(card.className).toContain("bg-overlay");
    expect(card.className).toContain("border-overlay-border");
    expect(card.className).toContain("shadow-overlay");
    expect(card.className).not.toMatch(/border-l-/);
    const icon = card.querySelector("svg") as SVGElement;
    expect(icon.getAttribute("class")).toContain(color);
    expect(screen.getByText("Username copied").className).toContain("font-semibold");
  });

  it("keeps the title and message texts", () => {
    mount({ id: "t1", type: "warning", title: "Sync paused", message: "The vault folder is not reachable. Changes are kept on this device." });
    expect(screen.getByText("Sync paused")).toBeInTheDocument();
    expect(screen.getByText("The vault folder is not reachable. Changes are kept on this device.").className).toContain("text-ink-secondary");
  });

  it("slides in, and slides out while exiting", () => {
    const { card } = mount({ id: "t1", type: "info", title: "Hello" });
    expect(card.className).toContain("animate-toast-in");
    cleanup();
    const exiting = mount({ id: "t2", type: "info", title: "Bye", exiting: true }).card;
    expect(exiting.className).toContain("animate-toast-out");
    expect(exiting.className).not.toContain("animate-toast-in");
  });

  it("renders every action as a small button in order, primary filled, and reports its id", () => {
    const { card, onAction } = mount({
      id: "t1",
      type: "warning",
      title: "Sync paused",
      actions: [
        { id: "t1:0", label: "Retry", variant: "primary" },
        { id: "t1:1", label: "Details" },
        { id: "t1:2", label: "Ignore", variant: "default" },
      ],
    });
    const labels = [...card.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Retry", "Details", "Ignore", ""]);
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.className).toContain("bg-btn-primary");
    expect(retry.className).toContain("h-control-sm");
    expect(screen.getByRole("button", { name: "Details" }).className).toContain("--c-btn-secondary-bg");
    expect(screen.getByRole("button", { name: "Ignore" }).className).toContain("--c-btn-secondary-bg");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(onAction).toHaveBeenCalledWith("t1:1");
  });

  it("dismisses through a close button labeled Dismiss", () => {
    const { onDismiss } = mount({ id: "t9", type: "error", title: "No password available" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledWith("t9");
  });

  it("shows progress with its labels and the speed after the right label", () => {
    const { card } = mount({
      id: "t1",
      type: "info",
      title: "Uploading",
      progress: { percent: 42, leftLabel: "File 1/3", rightLabel: "2.4 MB / 12.5 MB", speed: "5.2 MB/s" },
    });
    expect(screen.getByText("File 1/3")).toBeInTheDocument();
    expect(screen.getByText("2.4 MB / 12.5 MB — 5.2 MB/s")).toBeInTheDocument();
    const fill = card.querySelector("[style]") as HTMLElement;
    expect(fill.style.width).toBe("42%");
    expect(fill.className).toContain("bg-(--c-progress)");
  });

  it("clamps the progress and hides the label row without labels, even with a speed", () => {
    const { card } = mount({ id: "t1", type: "info", title: "Working", progress: { percent: 140, speed: "1 MB/s" } });
    expect((card.querySelector("[style]") as HTMLElement).style.width).toBe("100%");
    expect(screen.queryByText(/1 MB\/s/)).toBeNull();
  });

  it("shows the speed on the right when only a left label is set", () => {
    mount({ id: "t1", type: "info", title: "Working", progress: { percent: 10, leftLabel: "Downloading", speed: "1 MB/s" } });
    expect(screen.getByText("— 1 MB/s")).toBeInTheDocument();
  });
});
