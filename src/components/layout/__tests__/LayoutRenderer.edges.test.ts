import { describe, expect, it } from "vitest";
import { childEdges } from "../LayoutRenderer";

describe("childEdges", () => {
  const corner = { top: true, left: true };

  it("side by side: both keep the top, only the first keeps the left", () => {
    expect(childEdges("horizontal", corner)).toEqual([corner, { top: true, left: false }]);
  });

  it("stacked: both keep the left, only the first keeps the top", () => {
    expect(childEdges("vertical", corner)).toEqual([corner, { top: false, left: true }]);
  });

  it("never gives a child an edge its parent lacks", () => {
    const none = { top: false, left: false };
    expect(childEdges("horizontal", none)).toEqual([none, none]);
    expect(childEdges("vertical", none)).toEqual([none, none]);
  });
});
