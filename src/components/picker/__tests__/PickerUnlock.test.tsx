import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import PickerUnlock from "../PickerUnlock";
import { stubElectron, type Invoke } from "./fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(props: { vaultType?: "personal" | "team"; vaultExists?: boolean }, handler: Invoke = async () => null) {
  const invoke = stubElectron(handler);
  const onUnlocked = vi.fn();
  const onShowMain = vi.fn();
  render(
    <PickerUnlock vaultType={props.vaultType ?? "personal"} vaultExists={props.vaultExists ?? true} onUnlocked={onUnlocked} onShowMain={onShowMain} />,
  );
  return { invoke, onUnlocked, onShowMain };
}

describe("PickerUnlock", () => {
  it("personal vault: a focused password TextInput, no added show button, and a primary Unlock button", () => {
    mount({});
    const field = screen.getByPlaceholderText("Enter master password...");
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveClass("h-control");
    expect(screen.queryByRole("button", { name: /show password/i })).toBeNull();
    const unlock = screen.getByRole("button", { name: "Unlock" });
    expect(unlock).toHaveAttribute("type", "submit");
    expect(unlock).toHaveClass("bg-btn-primary");
    expect(unlock).toBeDisabled();
  });

  it("unlocks with the typed password and shows Unlocking... while busy", async () => {
    let finish: () => void = () => undefined;
    const { invoke, onUnlocked } = mount({}, (channel) =>
      channel === "vault_unlock" ? new Promise<null>((resolve) => { finish = () => resolve(null); }) : Promise.resolve(null),
    );
    fireEvent.change(screen.getByPlaceholderText("Enter master password..."), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    const busy = await screen.findByRole("button", { name: /Unlocking\.\.\./ });
    expect(busy).toBeDisabled();
    expect(invoke).toHaveBeenCalledWith("vault_unlock", { masterPassword: "secret" });
    await act(async () => finish());
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  it("shows the unlock error as an inline error", async () => {
    mount({}, async (channel) => {
      if (channel === "vault_unlock") throw new Error("Wrong password");
      return null;
    });
    fireEvent.change(screen.getByPlaceholderText("Enter master password..."), { target: { value: "nope" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    });
    const error = screen.getByText("Wrong password");
    expect(error).toHaveAttribute("data-cv-error");
    expect(error).toHaveClass("text-danger");
  });

  it("no vault: the same text and link", () => {
    const { onShowMain } = mount({ vaultExists: false });
    expect(screen.getByText("No vault configured")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Conduit to set up a vault" }));
    expect(onShowMain).toHaveBeenCalledTimes(1);
  });

  it("team vault: opens on its own, with its busy text", async () => {
    const { invoke, onUnlocked } = mount({ vaultType: "team" });
    expect(screen.getByText("Unlocking team vault...")).toBeInTheDocument();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("team_vault_open", undefined);
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  it("team vault: shows the error and Open Conduit when opening fails", async () => {
    const { onShowMain } = mount({ vaultType: "team" }, async () => {
      throw new Error("Not a member");
    });
    await act(async () => {});
    expect(screen.getByText("Not a member")).toHaveClass("text-danger");
    fireEvent.click(screen.getByRole("button", { name: "Open Conduit" }));
    expect(onShowMain).toHaveBeenCalledTimes(1);
  });
});
