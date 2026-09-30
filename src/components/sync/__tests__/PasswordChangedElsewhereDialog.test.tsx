import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PasswordChangedElsewhereDialog from "../PasswordChangedElsewhereDialog";

const payload = { code: "VAULT_PASSWORD_CHANGED_ELSEWHERE", changedByDeviceName: "Mac", changedMs: 0, needsPreviousPassword: true, deleteBiometric: false } as never;

afterEach(() => cleanup());

describe("PasswordChangedElsewhereDialog after an automatic unlock (docs/AUTO_UNLOCK.md 3.6)", () => {
  it("hides the previous-password field, adds the line and a checked keep box", () => {
    const onSubmit = vi.fn();
    render(<PasswordChangedElsewhereDialog payload={payload} busy={false} error={null} savedUnlockName="Work" onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.getByText("Conduit couldn't open Work automatically.")).toBeInTheDocument();
    expect(screen.queryByText("Previous master password")).toBeNull();
    const keep = screen.getByRole("checkbox", { name: /Keep unlocking automatically at startup/ });
    expect(keep).toBeChecked();
    const input = document.querySelector("input[type=password]") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new-pw" } });
    fireEvent.click(keep);
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledWith("new-pw", null, false);
  });

  it("keeps asking for the previous password without a saved unlock", () => {
    render(<PasswordChangedElsewhereDialog payload={payload} busy={false} error={null} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Previous master password")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
