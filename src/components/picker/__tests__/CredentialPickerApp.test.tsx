import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import CredentialPickerApp from "../CredentialPickerApp";
import { toast } from "../../common/Toast";
import { setIconPack, useIconPackStore } from "../../../lib/icons";
import { META, dto, iconMarkup, stubElectron, stubScrollIntoView, type Invoke } from "./fixtures";

stubScrollIntoView();

const unlockedVault: Invoke = async (channel) => {
  switch (channel) {
    case "vault_exists":
      return true;
    case "vault_get_type":
      return "personal";
    case "vault_is_unlocked":
      return true;
    case "credential_list":
      return META;
    case "credential_get":
      return dto();
    default:
      return null;
  }
};

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (useIconPackStore.getState().pack !== "lucide") {
    setIconPack("lucide");
    await waitFor(() => expect(useIconPackStore.getState().pack).toBe("lucide"));
  }
});

async function mount(handler: Invoke = unlockedVault) {
  const invoke = stubElectron(handler);
  const view = render(<CredentialPickerApp />);
  await act(async () => {});
  return { invoke, ...view };
}

function header(): HTMLElement {
  const title = screen.getByText("Credential Picker");
  const row = title.parentElement;
  if (!row) throw new Error("no header row");
  return row;
}

describe("CredentialPickerApp", () => {
  it("keeps the 44px header with its title and a named close button that closes the window", async () => {
    const { invoke } = await mount();
    expect(header()).toHaveClass("h-11");
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveAttribute("title", "Close");
    fireEvent.click(close);
    expect(invoke).toHaveBeenCalledWith("picker_close", undefined);
  });

  it("marks the header as the window's drag region and its close button as outside it", () => {
    // jsdom drops -webkit-app-region, so read React's own markup.
    stubElectron(unlockedVault);
    const html = renderToStaticMarkup(<CredentialPickerApp />);
    expect(html).toMatch(/<div class="[^"]*h-11[^"]*" style="-webkit-app-region:drag">/);
    expect(html).toMatch(/<button[^>]*aria-label="Close"[^>]*style="-webkit-app-region:no-drag"/);
  });

  it("uses overlay and divider tokens, not the legacy panel and stroke colors", async () => {
    const { container } = await mount();
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("bg-overlay", "border-overlay-border", "rounded-lg");
    expect(root.className).not.toMatch(/bg-panel|border-stroke/);
    expect(header()).toHaveClass("border-divider");
  });

  it("opens a credential with Enter, goes back with Escape, and closes the window with a second Escape", async () => {
    const { invoke } = await mount();
    fireEvent.keyDown(screen.getByPlaceholderText("Search credentials..."), { key: "Enter" });
    await screen.findByText("Username");
    expect(invoke).toHaveBeenCalledWith("credential_get", { id: "c1" });

    fireEvent.keyDown(window, { key: "Escape" });
    await screen.findByPlaceholderText("Search credentials...");
    expect(invoke).not.toHaveBeenCalledWith("picker_close", undefined);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(invoke).toHaveBeenCalledWith("picker_close", undefined);
  });

  it("shows the unlock prompt when the vault is locked", async () => {
    await mount(async (channel) => (channel === "vault_exists" ? true : channel === "vault_get_type" ? "personal" : false));
    expect(screen.getByText("Vault is locked")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter master password...")).toHaveAttribute("type", "password");
  });

  it("draws every icon from the active icon pack (spec 3.15)", async () => {
    const { container } = await mount();
    const lucide = iconMarkup(container);
    expect(lucide.length).toBeGreaterThanOrEqual(3);

    await act(async () => {
      setIconPack("tabler");
      await waitFor(() => expect(useIconPackStore.getState().pack).toBe("tabler"));
    });
    const tabler = iconMarkup(container);
    expect(tabler).toHaveLength(lucide.length);
    tabler.forEach((markup, i) => expect(markup).not.toBe(lucide[i]));
  });

  it("sends its toasts to the picker's own overlay window, which draws them (notification.md)", async () => {
    await mount();
    act(() => {
      toast.success("Password copied");
    });
    const send = window.electron.send as ReturnType<typeof vi.fn>;
    expect(send).toHaveBeenLastCalledWith("overlay:push-state", {
      toasts: [expect.objectContaining({ type: "success", title: "Password copied" })],
      update: null,
    });
    expect(document.querySelector("[data-toast]")).toBeNull();
  });
});
