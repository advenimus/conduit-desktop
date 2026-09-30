import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import PasswordGeneratorDialog from "../PasswordGeneratorDialog";
import PasswordGenerateButton from "../PasswordGenerateButton";
import SshKeyGeneratorDialog from "../SshKeyGeneratorDialog";
import SshKeyGenerateButton from "../SshKeyGenerateButton";
import type { ReactNode } from "react";
import { Dialog } from "../../ui";
import { clickScrim, closeButton, pressEscape, topPanel } from "../../common/__tests__/dialogClose";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const KEY = { privateKey: "PRIVATE", publicKey: "ssh-ed25519 AAAA user@host", fingerprint: "SHA256:abc" };

beforeEach(() => {
  invoke.mockImplementation(async (channel) => (channel === "ssh_generate_keypair" ? KEY : null));
  vi.stubGlobal("electron", { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  vi.unstubAllGlobals();
});

/** Quick Connect, Password Generator and SSH Key Generator: Escape closes, a scrim click does not, a close button (3.12.1). */
function expectDefaultCloseBehavior(onClose: ReturnType<typeof vi.fn>) {
  clickScrim();
  expect(onClose).not.toHaveBeenCalled();
  pressEscape();
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(closeButton() as HTMLButtonElement);
  expect(onClose).toHaveBeenCalledTimes(2);
}

describe("PasswordGeneratorDialog", () => {
  it("keeps its title, width, controls and footer order", () => {
    render(<PasswordGeneratorDialog onClose={() => {}} onUsePassword={() => {}} />);
    const panel = topPanel();
    expect(panel.querySelector("h2")).toHaveTextContent("Password Generator");
    expect(panel).toHaveStyle({ maxWidth: "512px" });
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Default", "Passphrase", "Pronounceable"]);
    for (const title of ["Hide", "Regenerate", "Copy"]) expect(screen.getByTitle(title)).toBeInTheDocument();
    expect(screen.getByLabelText("Generated Password")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Uppercase (A-Z)")).toBeChecked();
    const footer = [...panel.querySelectorAll("[data-cv-dialog-footer] button")].map((b) => b.textContent);
    expect(footer).toEqual(["Use Password", "Copy & Close"]);
  });

  it("switches modes through the segmented control", () => {
    render(<PasswordGeneratorDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Passphrase" }));
    expect(screen.getByText("Words")).toBeInTheDocument();
    expect(screen.getByLabelText("Separator")).toBeInTheDocument();
    expect(screen.queryByText("Use Password")).toBeNull();
  });

  it("closes on Escape and its close button, not on a scrim click", () => {
    const onClose = vi.fn();
    render(<PasswordGeneratorDialog onClose={onClose} />);
    expectDefaultCloseBehavior(onClose);
  });

  it("opens from PasswordGenerateButton, whose title stays", () => {
    render(<PasswordGenerateButton onPasswordGenerated={() => {}} />);
    fireEvent.click(screen.getByTitle("Password Generator"));
    expect(topPanel().querySelector("h2")).toHaveTextContent("Password Generator");
  });
});

describe("SshKeyGeneratorDialog", () => {
  it("keeps its controls, then widens to 768px and shows the key once generated", async () => {
    render(<SshKeyGeneratorDialog onClose={() => {}} onUseKey={() => {}} />);
    const panel = topPanel();
    expect(panel.querySelector("h2")).toHaveTextContent("SSH Key Generator");
    expect(panel).toHaveStyle({ maxWidth: "512px" });
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Ed25519recommended", "RSA", "ECDSA"]);
    fireEvent.click(screen.getByRole("radio", { name: "RSA" }));
    expect(screen.getByRole("radio", { name: "4096 bits" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Leave empty for no passphrase")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("user@hostname")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate Key Pair" }));
    });
    expect(topPanel()).toHaveStyle({ maxWidth: "768px" });
    expect(screen.getByText("SHA256:abc")).toBeInTheDocument();
    expect(screen.getByTitle("Copy public key")).toBeInTheDocument();
    expect(screen.getByTitle("Show")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate Key Pair" })).toBeInTheDocument();
    const footer = [...topPanel().querySelectorAll("[data-cv-dialog-footer] button")].map((b) => b.textContent);
    expect(footer).toEqual(["Copy Install Command", "Use Private Key", "Copy Public Key & Close"]);
  });

  it("flags mismatched passphrases", () => {
    render(<SshKeyGeneratorDialog onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Leave empty for no passphrase"), { target: { value: "a" } });
    fireEvent.change(screen.getByPlaceholderText("Confirm passphrase"), { target: { value: "b" } });
    expect(document.querySelector("[data-cv-error]")).toHaveTextContent("Passphrases do not match");
    expect(screen.getByRole("button", { name: "Generate Key Pair" })).toBeDisabled();
  });

  it("closes on Escape and its close button, not on a scrim click", () => {
    const onClose = vi.fn();
    render(<SshKeyGeneratorDialog onClose={onClose} />);
    expectDefaultCloseBehavior(onClose);
  });

  it("opens from SshKeyGenerateButton, whose title stays", () => {
    render(<SshKeyGenerateButton onKeyGenerated={() => {}} />);
    fireEvent.click(screen.getByTitle("SSH Key Generator"));
    expect(topPanel().querySelector("h2")).toHaveTextContent("SSH Key Generator");
  });
});

describe("generators opened from inside another dialog (the entry dialog)", () => {
  function EntryLike({ onClose, children }: { onClose: () => void; children: ReactNode }) {
    return (
      <Dialog open title="Edit Entry" onClose={onClose} closeOnEscape={false}>
        <input aria-label="Password" />
        {children}
      </Dialog>
    );
  }

  it.each([
    ["Password Generator", () => <PasswordGenerateButton onPasswordGenerated={() => {}} />],
    ["SSH Key Generator", () => <SshKeyGenerateButton onKeyGenerated={() => {}} />],
  ])("%s: Escape closes only the generator and Tab stays inside it", (title, button) => {
    const outer = vi.fn();
    render(<EntryLike onClose={outer}>{button()}</EntryLike>);
    fireEvent.click(screen.getByTitle(title));
    const generator = topPanel();
    expect(generator.querySelector("h2")).toHaveTextContent(title);
    const focusables = [...generator.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")].filter((el) => el.tabIndex >= 0);
    focusables[focusables.length - 1].focus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });
    expect(document.activeElement).not.toBe(focusables[focusables.length - 1]);
    expect(generator.contains(document.activeElement)).toBe(true);
    pressEscape();
    expect(document.querySelectorAll("[data-dialog-content]")).toHaveLength(1);
    expect(topPanel().querySelector("h2")).toHaveTextContent("Edit Entry");
    expect(outer).not.toHaveBeenCalled();
  });
});
