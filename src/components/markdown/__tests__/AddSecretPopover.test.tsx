import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/electron", () => ({
  invoke: vi.fn(async () => ({ id: "11111111-2222-4333-8444-555555555555", ref: "x" })),
  listenSync: vi.fn(() => () => undefined),
}));

const { default: AddSecretPopover } = await import("../AddSecretPopover");

describe("AddSecretPopover", () => {
  it("does not submit the form it sits in", async () => {
    const outerSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    const onInsert = vi.fn();
    render(
      <form onSubmit={outerSubmit}>
        <AddSecretPopover ownerId="o1" onInsert={onInsert} />
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add encrypted secret" }));
    fireEvent.change(screen.getByPlaceholderText("Leave empty to generate"), { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onInsert).toHaveBeenCalled());
    expect(outerSubmit).not.toHaveBeenCalled();
  });
});
