import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SessionTerminalTab from "../SessionTerminalTab";
import type { Settings } from "../../SettingsHelpers";
import { TERMINAL_FONT_FALLBACK } from "../../../../lib/terminalFont";

function Harness({ terminal, onSettings }: { terminal?: Record<string, unknown>; onSettings?: (s: Settings) => void }) {
  const [settings, setSettings] = useState<Settings>(
    () => ({ default_shell: "default", session_defaults_terminal: terminal }) as unknown as Settings,
  );
  onSettings?.(settings);
  return <SessionTerminalTab settings={settings} setSettings={setSettings} onClose={() => {}} />;
}

const originalQuery = (window as { queryLocalFonts?: unknown }).queryLocalFonts;

afterEach(() => {
  cleanup();
  (window as { queryLocalFonts?: unknown }).queryLocalFonts = originalQuery;
});

function fontInput(): HTMLInputElement {
  return screen.getByLabelText("Font Family") as HTMLInputElement;
}

function preview(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-cv-terminal-font-preview]");
  if (!el) throw new Error("no preview");
  return el;
}

describe("Settings > Sessions > Terminal font", () => {
  it("fills in the font for settings saved before it existed, keeping the other values", () => {
    let latest: Settings | null = null;
    render(<Harness terminal={{ fontSize: 16, scrollback: 500, cursorBlink: false }} onSettings={(s) => (latest = s)} />);
    expect(fontInput().value).toBe("");
    expect(fontInput().placeholder).toBe(TERMINAL_FONT_FALLBACK);

    fireEvent.change(fontInput(), { target: { value: "Maple Mono NF" } });
    expect(latest!.session_defaults_terminal).toEqual({ fontSize: 16, scrollback: 500, cursorBlink: false, fontFamily: "Maple Mono NF" });
  });

  it("previews the chosen font with the built-in fonts after it", () => {
    render(<Harness terminal={{ fontFamily: "Maple Mono NF" }} />);
    expect(preview().style.fontFamily).toContain("Maple Mono NF");
    expect(preview().style.fontFamily).toContain("Menlo");
    expect(preview().textContent).toContain("");
  });

  it("warns about a name the terminal cannot use", () => {
    render(<Harness terminal={{ fontFamily: 'Maple", Arial' }} />);
    expect(screen.getByText(/can't contain quotes/)).toBeInTheDocument();
    expect(preview().style.fontFamily).not.toContain("Arial");
  });

  it("explains when the system cannot list fonts, and typing still works", async () => {
    delete (window as { queryLocalFonts?: unknown }).queryLocalFonts;
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Browse Installed Fonts" }));
    expect(await screen.findByText(/can't list fonts here/)).toBeInTheDocument();
    fireEvent.change(fontInput(), { target: { value: "Fira Code" } });
    expect(fontInput().value).toBe("Fira Code");
  });

  it("offers the installed families as suggestions and flags a font that is not installed", async () => {
    (window as { queryLocalFonts?: unknown }).queryLocalFonts = vi.fn(async () => [{ family: "Maple Mono NF" }, { family: "Menlo" }]);
    render(<Harness terminal={{ fontFamily: "Not Installed" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse Installed Fonts" }));
    expect(await screen.findByText(/2 fonts found/)).toBeInTheDocument();
    const listId = fontInput().getAttribute("list");
    const options = [...document.querySelectorAll(`#${CSS.escape(listId!)} option`)].map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(["Maple Mono NF", "Menlo"]);
    expect(screen.getByText(/not found on this computer/)).toBeInTheDocument();

    fireEvent.change(fontInput(), { target: { value: "maple mono nf" } });
    expect(screen.queryByText(/not found on this computer/)).not.toBeInTheDocument();
  });

  it("says so when the font list permission is refused", async () => {
    (window as { queryLocalFonts?: unknown }).queryLocalFonts = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Browse Installed Fonts" }));
    expect(await screen.findByText(/wasn't allowed to list your fonts/)).toBeInTheDocument();
  });
});
