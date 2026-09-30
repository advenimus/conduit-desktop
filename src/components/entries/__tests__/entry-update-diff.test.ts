import { describe, it, expect } from "vitest";
import { changedEditorFields } from "../entry-update-diff";

describe("changedEditorFields (spec 7.2)", () => {
  const loaded: { name: string; host: string; port: number; tags: string[]; config: Record<string, string>; notes: string | null } = {
    name: "Prod",
    host: "10.0.0.5",
    port: 22,
    tags: ["prod"],
    config: { ssh_auth_method: "key" },
    notes: null,
  };

  it("leaves out fields the user did not touch, so a value resolved meanwhile is kept", () => {
    const current = { ...loaded, tags: ["prod"], config: { ssh_auth_method: "key" }, notes: "new note" };
    expect(changedEditorFields(loaded, current)).toEqual({ notes: "new note" });
  });

  it("sends changed lists and objects, and everything when nothing was loaded", () => {
    const current = { ...loaded, tags: ["prod", "db"], config: { ssh_auth_method: "password" } };
    expect(changedEditorFields(loaded, current)).toEqual({ tags: ["prod", "db"], config: { ssh_auth_method: "password" } });
    expect(changedEditorFields(null, loaded)).toEqual(loaded);
  });
});
