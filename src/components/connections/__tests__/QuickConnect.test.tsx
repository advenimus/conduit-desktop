import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import QuickConnect from "../QuickConnect";
import { useVaultStore } from "../../../stores/vaultStore";
import { clickScrim, closeButton, pressEscape, topPanel } from "../../common/__tests__/dialogClose";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const initialVault = useVaultStore.getState();

beforeEach(() => {
  invoke.mockResolvedValue(null);
  vi.stubGlobal("electron", { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() });
  useVaultStore.setState({
    isUnlocked: true,
    credentials: [{ id: "c1", name: "Domain Admin", username: "admin" }] as never,
    loadCredentials: vi.fn(async () => {}),
  });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  vi.unstubAllGlobals();
  useVaultStore.setState(initialVault, true);
});

/** The controls of INVENTORY shot 31, in order: tag and visible text, placeholder or title. */
function inventory(): string[] {
  const out: string[] = [];
  for (const el of topPanel().querySelectorAll<HTMLElement>("h2,button,input,select,label")) {
    const tag = el.tagName.toLowerCase();
    const own = tag === "label" ? (el.querySelector("span")?.textContent ?? "") : tag === "select" ? "" : (el.textContent ?? "");
    out.push(`${tag}:${own.trim() || el.getAttribute("placeholder") || el.getAttribute("title") || ""}`);
  }
  return out;
}

describe("QuickConnect", () => {
  it("keeps every control of shot 31 in today's order", () => {
    render(<QuickConnect onClose={() => {}} />);
    expect(inventory()).toEqual([
      "h2:Quick Connect",
      "button:Close",
      "button:SSH",
      "button:RDP",
      "button:VNC",
      "button:Web",
      "label:Host",
      "input:hostname or IP",
      "label:Port",
      "input:22",
      "label:Stored Credential",
      "select:",
      "label:Username",
      "input:username",
      "label:Password",
      "input:password",
      "button:Password Generator",
      "button:Show password",
      "button:Cancel",
      "button:Connect",
    ]);
    expect(topPanel()).toHaveStyle({ maxWidth: "448px" });
    expect(screen.getByLabelText("Host")).toHaveFocus();
  });

  it("switches the type with the segmented control and keeps the URL field for Web", () => {
    render(<QuickConnect onClose={() => {}} />);
    const web = screen.getByRole("radio", { name: "Web" });
    fireEvent.click(web);
    expect(web).toHaveAttribute("aria-checked", "true");
    expect(screen.getByPlaceholderText("https://example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "RDP" }));
    expect(screen.getByPlaceholderText("3389")).toBeInTheDocument();
  });

  it("shows a connection error as a danger callout", async () => {
    invoke.mockRejectedValueOnce(new Error("Host unreachable"));
    render(<QuickConnect onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "10.0.0.1" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });
    expect(document.querySelector("[data-cv-error]")).toHaveTextContent("Host unreachable");
  });

  it("closes on Escape and its close button, not on a scrim click (3.12.1)", () => {
    const onClose = vi.fn();
    render(<QuickConnect onClose={onClose} />);
    clickScrim();
    expect(onClose).not.toHaveBeenCalled();
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(closeButton() as HTMLButtonElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes only the password generator on Escape when it is open above", () => {
    const onClose = vi.fn();
    render(<QuickConnect onClose={onClose} />);
    fireEvent.click(screen.getByTitle("Password Generator"));
    expect(topPanel().querySelector("h2")).toHaveTextContent("Password Generator");
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    expect(topPanel().querySelector("h2")).toHaveTextContent("Quick Connect");
  });
});
