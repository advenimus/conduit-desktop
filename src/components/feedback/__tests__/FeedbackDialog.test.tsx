import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import FeedbackDialog from "../FeedbackDialog";
import { useAuthStore } from "../../../stores/authStore";
import { clickScrim, closeButton, pressEscape, topPanel } from "../../common/__tests__/dialogClose";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const initialAuth = useAuthStore.getState();
const SYSTEM = { appVersion: "1.2.3", platform: "darwin", arch: "arm64", nodeVersion: "22", electronVersion: "44", osVersion: "27" };

beforeEach(() => {
  invoke.mockImplementation(async (channel) => {
    if (channel === "feedback_get_system_info") return SYSTEM;
    if (channel === "feedback_submit") return { success: true };
    return null;
  });
  vi.stubGlobal("electron", { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() });
  useAuthStore.setState({ isAuthenticated: true, authMode: "authenticated" });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  vi.unstubAllGlobals();
  useAuthStore.setState(initialAuth, true);
});

async function mount(type: "bug" | "feedback", onClose = vi.fn()) {
  render(<FeedbackDialog type={type} onClose={onClose} />);
  await act(async () => {});
  return onClose;
}

describe("FeedbackDialog", () => {
  it("keeps the bug report's title, fields, system info, checkbox, screenshots and footer", async () => {
    await mount("bug");
    const panel = topPanel();
    expect(panel.querySelector("h2")).toHaveTextContent("Submit a Bug");
    expect(panel).toHaveStyle({ maxWidth: "512px" });
    expect(screen.getByLabelText("Title")).toHaveAttribute("placeholder", "Brief summary of the issue");
    expect(screen.getByLabelText("Description")).toHaveAttribute("placeholder", "Steps to reproduce, expected vs actual behavior...");
    expect(panel).toHaveTextContent("System Information");
    expect(panel).toHaveTextContent("Conduit v1.2.3");
    expect(screen.getByLabelText("Include recent application logs")).toBeChecked();
    expect(screen.getByRole("button", { name: "Attach Screenshots" })).toBeEnabled();
    const footer = [...panel.querySelectorAll("[data-cv-dialog-footer] button")].map((b) => b.textContent);
    expect(footer).toEqual(["Cancel", "Submit"]);
  });

  it("shows the sign-in note and disables the fields when signed out", async () => {
    useAuthStore.setState({ isAuthenticated: false, authMode: "local" });
    await mount("feedback");
    expect(topPanel().querySelector("h2")).toHaveTextContent("Submit Feedback");
    expect(screen.getByText("Sign in to submit feedback. You can sign in from the account menu.")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.queryByText("Attach Screenshots")).toBeNull();
  });

  it("submits with Cmd+Enter", async () => {
    const onClose = await mount("feedback");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Idea" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Details" } });
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Description"), { key: "Enter", metaKey: true });
    });
    expect(invoke).toHaveBeenCalledWith("feedback_submit", expect.objectContaining({ type: "feedback", title: "Idea" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape, a scrim click and its close button (3.12.1)", async () => {
    const onClose = await mount("feedback");
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    clickScrim();
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(closeButton() as HTMLButtonElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
