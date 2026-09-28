import { describe, it, expect } from "vitest";
import { strengthTone } from "../strengthTone";

describe("strengthTone", () => {
  it("maps each scorePassword color to token classes, weakest to strongest", () => {
    expect(strengthTone("red-500")).toEqual({ bar: "bg-danger", text: "text-danger" });
    expect(strengthTone("orange-500").bar).toContain("--c-danger");
    expect(strengthTone("orange-500").bar).toContain("--c-warning");
    expect(strengthTone("yellow-500")).toEqual({ bar: "bg-warning", text: "text-warning" });
    expect(strengthTone("green-500").bar).toContain("--c-success");
    expect(strengthTone("emerald-500")).toEqual({ bar: "bg-success", text: "text-success" });
  });

  it("uses no Tailwind palette colors", () => {
    for (const color of ["red-500", "orange-500", "yellow-500", "green-500", "emerald-500"]) {
      const { bar, text } = strengthTone(color);
      expect(`${bar} ${text}`).not.toMatch(/-(red|orange|yellow|green|emerald)-\d/);
    }
  });

  it("falls back to the weakest tone for an unknown color", () => {
    expect(strengthTone("purple-500")).toEqual(strengthTone("red-500"));
  });
});
