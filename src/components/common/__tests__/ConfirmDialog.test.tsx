import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ConfirmDialog from "../ConfirmDialog";
import { freezeHolders } from "../../../lib/native-freeze";
import { clickScrim, closeButton, pressEscape, topPanel } from "./dialogClose";

afterEach(() => {
  cleanup();
  expect(freezeHolders()).toEqual([]);
});

function renderConfirm(extra: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <div data-testid="host">
      <ConfirmDialog title="Delete Entry" message={'Are you sure you want to delete "db"?'} confirmLabel="Delete" variant="danger" onConfirm={onConfirm} onCancel={onCancel} {...extra} />
    </div>,
  );
  return { onConfirm, onCancel, view };
}

describe("ConfirmDialog", () => {
  it("keeps the harness markup: an h2 title, the message, then Cancel and the confirm button in the footer", () => {
    renderConfirm();
    const panel = topPanel();
    expect(panel.querySelector("h2")).toHaveTextContent("Delete Entry");
    expect(panel).toHaveTextContent('Are you sure you want to delete "db"?');
    const buttons = [...panel.querySelectorAll("[data-cv-dialog-footer] button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Cancel", "Delete"]);
    expect(panel.querySelector(":scope > div:last-child button")).toHaveTextContent("Cancel");
    expect(panel).toHaveStyle({ maxWidth: "448px" });
  });

  it("calls onCancel and onConfirm from its buttons", () => {
    const { onConfirm, onCancel } = renderConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("uses a danger button for variant danger and a primary one by default", () => {
    renderConfirm();
    expect(screen.getByRole("button", { name: "Delete" }).className).toContain("bg-btn-danger");
    cleanup();
    renderConfirm({ variant: undefined, confirmLabel: undefined });
    expect(screen.getByRole("button", { name: "Confirm" }).className).toContain("bg-btn-primary");
  });

  it("takes a cancelLabel", () => {
    renderConfirm({ cancelLabel: "Keep" });
    expect(screen.getByRole("button", { name: "Keep" })).toBeInTheDocument();
  });

  it("has no close button and ignores Escape and a scrim click (3.12.1)", () => {
    const { onCancel } = renderConfirm();
    expect(closeButton()).toBeNull();
    pressEscape();
    clickScrim();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels on Escape with closeOnEscape", () => {
    const { onCancel } = renderConfirm({ closeOnEscape: true });
    pressEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders in place on the base layer without a layer prop", () => {
    const { view } = renderConfirm();
    const host = view.getByTestId("host");
    expect(host.querySelector("[data-dialog-content]")).not.toBeNull();
    expect(topPanel().parentElement).toHaveAttribute("data-cv-layer", "base");
  });

  it("portals to document.body on the given layer", () => {
    const { view } = renderConfirm({ layer: "stacked" });
    expect(view.getByTestId("host").querySelector("[data-dialog-content]")).toBeNull();
    expect(document.querySelector('[data-cv-layer="stacked"] [data-dialog-content] button')).not.toBeNull();
  });

  it("holds exactly one dialog freeze labeled with its title", () => {
    renderConfirm();
    expect(freezeHolders()).toEqual([expect.objectContaining({ reason: "dialog", label: "Delete Entry" })]);
  });
});
