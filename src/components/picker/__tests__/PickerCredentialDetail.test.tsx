import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import PickerCredentialDetail from "../PickerCredentialDetail";
import { dto } from "./fixtures";

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("../../common/Toast", () => ({ toast: toastMocks }));

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  writeText.mockReset();
  toastMocks.success.mockReset();
  toastMocks.error.mockReset();
});

describe("PickerCredentialDetail", () => {
  it("keeps the back button, now named, and the credential name", () => {
    const onBack = vi.fn();
    render(<PickerCredentialDetail credential={dto()} onBack={onBack} />);
    expect(screen.getByText("Domain Admin")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("lists today's fields in order with the password masked", () => {
    render(<PickerCredentialDetail credential={dto({ private_key: "KEY" })} onBack={vi.fn()} />);
    const labels = [...document.querySelectorAll(".text-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Username", "Password", "Domain", "Private Key"]);
    expect(screen.getAllByText("••••••••••••")).toHaveLength(2);
    expect(screen.queryByText("hunter2")).toBeNull();
  });

  it("shows and hides secrets with the Show / Hide button and keeps its titles", () => {
    render(<PickerCredentialDetail credential={dto()} onBack={vi.fn()} />);
    const show = screen.getByRole("button", { name: "Show" });
    expect(show).toHaveAttribute("title", "Show");
    fireEvent.click(show);
    expect(screen.getByText("hunter2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide" })).toHaveAttribute("title", "Hide");
  });

  it("copies a value, confirms with a toast and a success check", async () => {
    render(<PickerCredentialDetail credential={dto()} onBack={vi.fn()} />);
    const copies = screen.getAllByRole("button", { name: "Copy" });
    expect(copies).toHaveLength(3);
    copies.forEach((b) => expect(b).toHaveAttribute("title", "Copy"));
    await act(async () => {
      fireEvent.click(copies[1]);
    });
    expect(writeText).toHaveBeenCalledWith("hunter2");
    expect(toastMocks.success).toHaveBeenCalledWith("Password copied");
    expect(screen.getAllByRole("button", { name: "Copy" })[1]).toHaveClass("text-success");
  });

  it("reports a failed copy with an error toast", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<PickerCredentialDetail credential={dto()} onBack={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[0]);
    });
    expect(toastMocks.error).toHaveBeenCalledWith("Failed to copy to clipboard");
  });

  it("shows the TOTP code split in two with its countdown", () => {
    render(<PickerCredentialDetail credential={dto({ password: null, totp_secret: "JBSWY3DPEHPK3PXP" })} onBack={vi.fn()} />);
    expect(screen.getByText("TOTP Code")).toBeInTheDocument();
    expect(screen.getByText(/^\d{3} \d{3}$/)).toHaveClass("font-mono", "text-title");
    expect(screen.getByText(/^\d+s$/)).toBeInTheDocument();
  });

  it("says so when there is nothing to show", () => {
    render(<PickerCredentialDetail credential={dto({ username: null, password: null, domain: null })} onBack={vi.fn()} />);
    expect(screen.getByText("No fields to display")).toBeInTheDocument();
  });
});
