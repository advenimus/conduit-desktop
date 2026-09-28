import { describe, expect, it } from "vitest";
import { mergeChangedSettings } from "../settings-merge";

describe("mergeChangedSettings", () => {
  const original = { theme: "dark", last_vault_path: "/old/Vault.conduit", recent_vaults: ["/old/Vault.conduit"], ui_scale: 1 };

  it("keeps what changed on disk while the dialog was open (vault moved by sync)", () => {
    const fresh = { ...original, last_vault_path: "/new/Vault.conduit", recent_vaults: ["/new/Vault.conduit"] };
    const edited = { ...original, theme: "light" };
    expect(mergeChangedSettings(fresh, original, edited)).toEqual({
      theme: "light",
      last_vault_path: "/new/Vault.conduit",
      recent_vaults: ["/new/Vault.conduit"],
      ui_scale: 1,
    });
  });

  it("applies nested and array edits by value", () => {
    const edited = { ...original, recent_vaults: [] as string[] };
    expect(mergeChangedSettings({ ...original }, original, edited).recent_vaults).toEqual([]);
  });

  it("without a loaded original, every edited key wins", () => {
    const fresh = { ...original, theme: "system" };
    expect(mergeChangedSettings(fresh, null, { ...original, ui_scale: 1.25 })).toEqual({ ...original, ui_scale: 1.25 });
  });
});
