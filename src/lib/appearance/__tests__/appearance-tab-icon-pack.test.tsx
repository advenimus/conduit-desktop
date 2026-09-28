// Settings > Appearance > Icon pack (spec 5.8, 6.4). Lives beside the appearance runtime because the
// settings tabs directory belongs to another package in this wave.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import AppearanceTab from "../../../components/settings/tabs/AppearanceTab";
import type { Settings } from "../../../components/settings/SettingsHelpers";
import { DEFAULT_ICON_PACK, ICON_PACKS, getPackMapping, setIconPack, useIconPackStore } from "../../icons";

const PRELOAD_TIMEOUT_MS = 30_000;

function baseSettings(iconPack: string): Settings {
  return { theme: "dark", color_scheme: "modern", icon_pack: iconPack, ui_scale: 1 } as Settings;
}

function Harness({ initialPack = "lucide", onSettings }: { initialPack?: string; onSettings?: (s: Settings) => void }) {
  const [settings, setSettings] = useState<Settings>(() => baseSettings(initialPack));
  onSettings?.(settings);
  return <AppearanceTab settings={settings} setSettings={setSettings} onClose={() => {}} />;
}

afterEach(async () => {
  cleanup();
  await act(() => setIconPack(DEFAULT_ICON_PACK));
});

function section(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-cv-appearance="icon-pack"]');
  if (!el) throw new Error("no Icon pack section");
  return el;
}

describe("Appearance tab: Icon pack section", () => {
  it("comes first, labeled by a <label> like its siblings, with six cards in picker order", () => {
    render(<Harness />);
    const tab = section().parentElement as HTMLElement;
    expect(tab.firstElementChild).toBe(section());
    const label = section().querySelector("label");
    expect(label?.textContent).toBe("Icon pack");
    expect([...tab.querySelectorAll("label")].map((l) => l.textContent?.trim())).toEqual(["Icon pack", "Color Scheme", "Brightness", "UI Scale"]);

    const group = within(section()).getByRole("radiogroup");
    expect(group).toHaveAttribute("aria-labelledby", label?.id);
    expect(group.className).toContain("grid-cols-3");
    const cards = within(group).getAllByRole("radio");
    expect(cards.map((c) => c.getAttribute("data-cv-choice"))).toEqual(["lucide", "phosphor", "hugeicons", "material", "fluent", "tabler"]);
    ICON_PACKS.forEach((pack, i) => {
      expect(cards[i].textContent?.startsWith(pack.label), pack.id).toBe(true);
      expect(cards[i]).toHaveTextContent(pack.description);
    });
    expect(within(cards[0]).getByText("Default")).toBeInTheDocument();
    expect(cards.slice(1).some((c) => within(c).queryByText("Default"))).toBe(false);
  });

  it("checks the saved pack, and Lucide for a value that is no pack any more", () => {
    render(<Harness initialPack="fluent" />);
    expect(within(section()).getByRole("radio", { name: /^Fluent/ })).toHaveAttribute("aria-checked", "true");
    cleanup();
    render(<Harness initialPack="codicons" />);
    expect(within(section()).getByRole("radio", { name: /^Lucide/ })).toHaveAttribute("aria-checked", "true");
  });

  it(
    "preloads every pack and previews each card from its own pack",
    async () => {
      render(<Harness />);
      await waitFor(() => expect([...useIconPackStore.getState().loaded].sort()).toEqual(ICON_PACKS.map((p) => p.id).sort()), { timeout: PRELOAD_TIMEOUT_MS });
      await act(async () => {});
      const cards = within(section()).getAllByRole("radio");
      const previews = cards.map((card) => card.querySelector("span.bg-well") as HTMLElement);
      for (const [i, preview] of previews.entries()) {
        expect(preview.querySelectorAll("svg"), ICON_PACKS[i].id).toHaveLength(8);
      }
      ICON_PACKS.forEach((pack, i) => {
        const Folder = getPackMapping(pack.id)!.folder;
        const expected = render(<Folder size={16} />).container.innerHTML;
        expect(previews[i].querySelector("svg")!.outerHTML, pack.id).toBe(expected);
      });
    },
    PRELOAD_TIMEOUT_MS,
  );

  it("a click selects the card, sets icon_pack and previews it live through conduit:theme-change", async () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    document.addEventListener("conduit:theme-change", listener);
    let latest: Settings | null = null;
    render(<Harness onSettings={(s) => (latest = s)} />);
    fireEvent.click(within(section()).getByRole("radio", { name: /^Hugeicons/ }));
    document.removeEventListener("conduit:theme-change", listener);

    expect(within(section()).getByRole("radio", { name: /^Hugeicons/ })).toHaveAttribute("aria-checked", "true");
    expect(latest!.icon_pack).toBe("hugeicons");
    expect(seen).toEqual([{ iconPack: "hugeicons" }]);
    await vi.waitFor(() => expect(useIconPackStore.getState().pack).toBe("hugeicons"), { timeout: PRELOAD_TIMEOUT_MS });
    expect(document.documentElement.getAttribute("data-cv-icon-pack")).toBe("hugeicons");
  });
});
