import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import AuthScreen from "../AuthScreen";
import { useAuthStore } from "../../../stores/authStore";

const openLogin = vi.fn();
const openSignup = vi.fn();
const enterLocalMode = vi.fn();

beforeEach(() => {
  useAuthStore.setState({ openLogin, openSignup, enterLocalMode, error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const button = (name: string) => screen.getByRole("button", { name });

describe("AuthScreen", () => {
  it("keeps the controls of shot 00 in their order", () => {
    render(<AuthScreen />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Conduit");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Sign In",
      "Create Account",
      "Continue without signing in",
    ]);
  });

  it("titles the screen in text-display on the editor background", () => {
    const { container } = render(<AuthScreen />);
    expect(screen.getByRole("heading", { level: 1 }).className).toContain("text-display");
    expect((container.firstChild as HTMLElement).className).toContain("bg-editor");
  });

  it("draws the main actions as large primitive buttons", () => {
    render(<AuthScreen />);
    const signIn = button("Sign In");
    expect(signIn).toHaveAttribute("data-cv-text-button");
    expect(signIn.className).toContain("h-control-lg");
    expect(signIn.className).toContain("bg-btn-primary");
    expect(signIn.className).toContain("w-full");

    const local = button("Continue without signing in");
    expect(local.className).toContain("h-control-lg");
    expect(local.className).toContain("bg-(--c-btn-secondary-bg)");
    expect(local.className).toContain("w-full");

    expect(button("Create Account").className).toContain("text-link");
  });

  it("shows the trial note as an info callout", () => {
    render(<AuthScreen />);
    const title = screen.getByText("30-day free trial of Pro");
    const callout = title.closest(".bg-info-bg");
    expect(callout).not.toBeNull();
    expect(callout!.textContent).toContain("Use one vault on all your devices at once. No commitment.");
  });

  it("wires each action to the auth store", () => {
    render(<AuthScreen />);
    fireEvent.click(button("Create Account"));
    expect(openSignup).toHaveBeenCalledTimes(1);
    cleanup();

    render(<AuthScreen />);
    fireEvent.click(button("Continue without signing in"));
    expect(enterLocalMode).toHaveBeenCalledTimes(1);

    fireEvent.click(button("Sign In"));
    expect(openLogin).toHaveBeenCalledTimes(1);
  });

  it("waits for the browser after Sign In and can open it again", () => {
    render(<AuthScreen />);
    fireEvent.click(button("Sign In"));
    expect(screen.getByText("Complete sign-in in your browser...")).toBeInTheDocument();
    const again = button("Open browser again");
    expect(again.className).toContain("text-link");
    fireEvent.click(again);
    expect(openLogin).toHaveBeenCalledTimes(2);
  });

  it("shows an error as a danger callout the harness can read", () => {
    useAuthStore.setState({ error: "Sign-in failed" });
    render(<AuthScreen />);
    const message = screen.getByText("Sign-in failed");
    expect(message).toHaveAttribute("data-cv-error");
    expect(message.closest(".bg-danger-bg")).not.toBeNull();
  });
});
