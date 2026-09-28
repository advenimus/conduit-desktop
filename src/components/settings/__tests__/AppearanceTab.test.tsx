import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppearanceTab from "../tabs/AppearanceTab";
import type { Settings } from "../SettingsHelpers";
import { COLOR_SCHEMES } from "../../../lib/schemes";

function Harness({ initial, onSettings }: { initial?: Partial<Settings>; onSettings?: (s: Settings) => void }) {
  const [settings, setSettings] = useState<Settings>(
    () => ({ theme: "dark", color_scheme: "modern", icon_pack: "lucide", ui_scale: 1, ...initial }) as Settings,
  );
  onSettings?.(settings);
  return <AppearanceTab settings={settings} setSettings={setSettings} onClose={() => {}} />;
}

function section(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-cv-appearance="${name}"]`);
  if (!el) throw new Error(`no ${name} section`);
  return el;
}

function captureThemeChanges(): { detail: unknown[]; stop: () => void } {
  const detail: unknown[] = [];
  const listener = (e: Event) => detail.push((e as CustomEvent).detail);
  document.addEventListener("conduit:theme-change", listener);
  return { detail, stop: () => document.removeEventListener("conduit:theme-change", listener) };
}

const originalElectron = window.electron;

afterEach(() => {
  cleanup();
  window.electron = originalElectron;
});

describe("Appearance tab, final form (spec 6.4)", () => {
  it("keeps four <label> section labels in the section label look, in today's order", () => {
    render(<Harness />);
    const order = ["icon-pack", "scheme", "mode", "scale"];
    expect([...document.querySelectorAll("[data-cv-appearance]")].map((el) => el.getAttribute("data-cv-appearance"))).toEqual(order);
    const labels = order.map((name) => section(name).querySelector("label") as HTMLLabelElement);
    expect(labels.map((l) => l.textContent)).toEqual(["Icon pack", "Color Scheme", "Brightness", "UI Scale"]);
    for (const label of labels) expect(label.className).toContain("text-label font-semibold text-ink-secondary");
  });

  it("draws the schemes as ChoiceCards, Modern first, and previews a pick live", () => {
    let latest: Settings | null = null;
    render(<Harness initial={{ color_scheme: "ocean" }} onSettings={(s) => (latest = s)} />);
    const group = within(section("scheme")).getByRole("radiogroup");
    expect(group.className).toContain("grid-cols-3");
    const cards = within(group).getAllByRole("radio");
    expect(cards.map((c) => c.getAttribute("data-cv-choice"))).toEqual(COLOR_SCHEMES.map((s) => s.id));
    expect(cards.map((c) => c.textContent)).toEqual(COLOR_SCHEMES.map((s) => s.label));
    expect(cards[1]).toHaveAttribute("aria-checked", "true");

    const events = captureThemeChanges();
    fireEvent.click(within(group).getByRole("radio", { name: "Ember" }));
    events.stop();
    expect(latest!.color_scheme).toBe("ember");
    expect(events.detail).toEqual([{ colorScheme: "ember" }]);
    expect(within(group).getByRole("radio", { name: "Ember" })).toHaveAttribute("aria-checked", "true");
  });

  it("offers Dark, Light and System on a SegmentedControl that previews the mode", () => {
    let latest: Settings | null = null;
    render(<Harness onSettings={(s) => (latest = s)} />);
    const group = within(section("mode")).getByRole("radiogroup");
    expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Dark", "Light", "System"]);
    expect(within(group).getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");

    const events = captureThemeChanges();
    fireEvent.click(within(group).getByRole("radio", { name: "Light" }));
    events.stop();
    expect(latest!.theme).toBe("light");
    expect(events.detail).toEqual([{ theme: "light" }]);
  });

  it("scales the UI with a Slider and resets it to 100%", () => {
    const send = vi.fn();
    window.electron = { send } as unknown as typeof window.electron;
    let latest: Settings | null = null;
    render(<Harness initial={{ ui_scale: 1.25 }} onSettings={(s) => (latest = s)} />);
    const slider = within(section("scale")).getByRole("slider");
    expect(slider).toHaveValue("75");
    expect(within(section("scale")).getByText("125%")).toBeInTheDocument();
    expect(within(section("scale")).getByText("75%")).toBeInTheDocument();

    fireEvent.change(slider, { target: { value: "0" } });
    expect(latest!.ui_scale).toBe(0.75);
    fireEvent.mouseUp(slider);
    expect(send).toHaveBeenLastCalledWith("set-zoom-factor", 0.75);

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(latest!.ui_scale).toBe(1);
    expect(send).toHaveBeenLastCalledWith("set-zoom-factor", 1);
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });
});
