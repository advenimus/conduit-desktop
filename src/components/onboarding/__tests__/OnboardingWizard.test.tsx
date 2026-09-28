import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import OnboardingWizard from "../OnboardingWizard";
import { getStepsForTier } from "../onboarding-steps";
import { useAuthStore } from "../../../stores/authStore";

const invoke = vi.fn();
const freeSteps = getStepsForTier("free");

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockImplementation(async (cmd: string) => (cmd === "settings_get" ? { theme: "dark" } : undefined));
  vi.stubGlobal("electron", { platform: "darwin", invoke, on: vi.fn(() => () => {}), send: vi.fn(), removeListener: vi.fn() });
  useAuthStore.setState({ profile: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const button = (name: string) => screen.getByRole("button", { name });

function advance() {
  act(() => {
    vi.advanceTimersByTime(250);
  });
}

describe("OnboardingWizard", () => {
  it("titles each step in text-display", () => {
    render(<OnboardingWizard onComplete={() => {}} />);
    const title = screen.getByRole("heading", { level: 2 });
    expect(title.textContent).toBe(freeSteps[0].title);
    expect(title.className).toContain("text-display");
  });

  it("draws Next, Back and Get Started as large primitive buttons", () => {
    render(<OnboardingWizard onComplete={() => {}} />);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    const next = button("Next");
    expect(next).toHaveAttribute("data-cv-text-button");
    expect(next.className).toContain("h-control-lg");
    expect(next.className).toContain("bg-btn-primary");

    fireEvent.click(next);
    advance();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(freeSteps[1].title);
    const back = button("Back");
    expect(back.className).toContain("h-control-lg");
    expect(back.className).toContain("bg-(--c-btn-secondary-bg)");

    for (let i = 2; i < freeSteps.length; i++) {
      fireEvent.click(button("Next"));
      advance();
    }
    const start = button("Get Started");
    expect(start.className).toContain("h-control-lg");
    expect(start.className).toContain("bg-btn-primary");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  it("keeps the footer order: Skip, the step dots, Back, then the forward action", () => {
    render(<OnboardingWizard onComplete={() => {}} />);
    fireEvent.click(button("Next"));
    advance();
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).toEqual([
      ...freeSteps.map((_, i) => `Go to step ${i + 1}`),
      "Skip",
      "Back",
      "Next",
    ]);
  });

  it("names the step dots and marks the current one", () => {
    render(<OnboardingWizard onComplete={() => {}} />);
    const current = button("Go to step 1");
    expect(current).toHaveAttribute("aria-current", "step");
    expect(current.className).toContain("bg-accent");
    fireEvent.click(button("Go to step 3"));
    advance();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(freeSteps[2].title);
    expect(button("Go to step 3")).toHaveAttribute("aria-current", "step");
    expect(button("Go to step 1")).not.toHaveAttribute("aria-current");
  });

  it("saves onboarding_completed and finishes on Skip", async () => {
    const onComplete = vi.fn();
    render(<OnboardingWizard onComplete={onComplete} />);
    await act(async () => {
      fireEvent.click(button("Skip"));
    });
    expect(invoke).toHaveBeenCalledWith("settings_save", { settings: { theme: "dark", onboarding_completed: true } });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("still finishes when saving the setting fails", async () => {
    invoke.mockRejectedValue(new Error("disk full"));
    const onComplete = vi.fn();
    render(<OnboardingWizard onComplete={onComplete} />);
    await act(async () => {
      fireEvent.click(button("Skip"));
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("labels each step with its tier in title case", () => {
    render(<OnboardingWizard onComplete={() => {}} />);
    const label = screen.getByText("Included");
    expect(label.className).toContain("text-meta");
    expect(label.className).not.toContain("uppercase");
  });
});
