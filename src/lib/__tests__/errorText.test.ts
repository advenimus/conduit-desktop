import { describe, it, expect } from "vitest";
import { errorText } from "../errorText";

describe("errorText", () => {
  it("reads an Error's message, which is what invoke() rejects with", () => {
    expect(errorText(new Error("Current password is incorrect"), "Failed")).toBe("Current password is incorrect");
  });

  it("reads a plain string error", () => {
    expect(errorText("Vault file not found", "Failed")).toBe("Vault file not found");
  });

  it("reads the message of an error-like object, such as a serialized IPC or Supabase error", () => {
    expect(errorText({ message: "Seat limit reached", code: "P0001" }, "Failed")).toBe("Seat limit reached");
  });

  it("trims the message", () => {
    expect(errorText(new Error("  Timed out \n"), "Failed")).toBe("Timed out");
  });

  it.each([
    ["an empty Error", new Error("")],
    ["a blank string", "   "],
    ["an object without a message", { code: 42 }],
    ["an object whose message is not text", { message: 42 }],
    ["null", null],
    ["undefined", undefined],
    ["a number", 500],
  ])("falls back for %s", (_label, err) => {
    expect(errorText(err, "Failed to rename vault")).toBe("Failed to rename vault");
  });
});
