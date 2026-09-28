import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import StartupStatus from "../StartupStatus";

type Progress = { phase: "checking" | "deps" | "binary" | "done" | "error"; message: string; detail?: string };

let emit: (payload: Progress) => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("electron", {
    platform: "darwin",
    invoke: vi.fn(),
    send: vi.fn(),
    removeListener: vi.fn(),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      if (event === "freerdp:build-progress") emit = (payload) => act(() => handler(payload));
      return () => {};
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(): Promise<HTMLElement | null> {
  const view = render(<StartupStatus />);
  await act(async () => {});
  return view.container;
}

const strip = () => document.querySelector("[data-cv-startup-status]") as HTMLElement | null;

describe("StartupStatus", () => {
  it("renders nothing until a build reports progress, and skips the checking phase", async () => {
    await mount();
    expect(strip()).toBeNull();
    emit({ phase: "checking", message: "Checking FreeRDP helper" });
    expect(strip()).toBeNull();
  });

  it("shows the 24px strip with the label, message, detail and progress while building", async () => {
    await mount();
    emit({ phase: "binary", message: "Building FreeRDP helper", detail: "cc -o helper" });
    const el = strip()!;
    expect(el.className).toContain("h-6");
    expect(el.className).toContain("border-divider");
    expect(el.className).toContain("bg-shell");
    expect(screen.getByText("FreeRDP Helper:").className).toContain("text-ink-muted");
    expect(screen.getByText("Building FreeRDP helper").className).toContain("text-ink-secondary");
    expect(screen.getByText("— cc -o helper").className).toContain("text-ink-faint");
    expect(el.querySelector(".animate-indeterminate")?.className).toContain("bg-(--c-progress)");
    expect(el.querySelector("svg")?.getAttribute("class")).toContain("text-info");
  });

  it("uses the success tone when done and hides itself after 4 seconds", async () => {
    await mount();
    emit({ phase: "done", message: "FreeRDP helper ready" });
    expect(screen.getByText("FreeRDP helper ready").className).toContain("text-success");
    expect(strip()!.querySelector(".animate-indeterminate")).toBeNull();
    act(() => vi.advanceTimersByTime(4000));
    expect(strip()).toBeNull();
  });

  it("uses the danger tone on error and keeps it for 10 seconds", async () => {
    await mount();
    emit({ phase: "error", message: "Build failed" });
    expect(screen.getByText("Build failed").className).toContain("text-danger");
    act(() => vi.advanceTimersByTime(9000));
    expect(strip()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(strip()).toBeNull();
  });

  it("dismisses through its Dismiss icon button", async () => {
    await mount();
    emit({ phase: "deps", message: "Downloading dependencies" });
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect(dismiss.getAttribute("title")).toBe("Dismiss");
    fireEvent.click(dismiss);
    expect(strip()).toBeNull();
  });
});
