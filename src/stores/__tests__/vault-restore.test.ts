import { describe, it, expect, vi, beforeEach } from "vitest";
import { useVaultStore } from "../vaultStore";
import { useSyncStore } from "../syncStore";
import type { RestoreResult, RollbackPreview } from "../../types/sync";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

const PREVIEW: RollbackPreview = { deletions: [], restorations: [], replacements: [], unreadableSecrets: 0 };

function answer(restore: RestoreResult) {
  invoke.mockImplementation((ch) => Promise.resolve(ch.endsWith("_restore") ? restore : []));
}

function restoreCalls() {
  return invoke.mock.calls.filter(([ch]) => ch.endsWith("_restore"));
}

function openPreview() {
  const view = useSyncStore.getState().view;
  if (view?.kind !== "restore-preview") throw new Error("no restore preview");
  return view;
}

beforeEach(() => {
  invoke.mockReset();
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useSyncStore.setState({ view: null });
  useVaultStore.setState({ isUnlocked: true, isLoading: false, error: null });
});

describe("backup restore into a vault the sync engine runs", () => {
  it("cloud backup: the preview opens the dialog, which re-runs the restore with a mode and target", async () => {
    answer({ mode: "preview", preview: PREVIEW });
    await useVaultStore.getState().restoreFromBackup("u1/v/1.enc", "pw", "Vault");
    expect(useVaultStore.getState().isLoading).toBe(false);
    const view = openPreview();
    expect(view.preview).toEqual(PREVIEW);

    answer({ mode: "new-vault", path: "/n.conduit", lineageId: "L2" });
    await expect(view.apply("new-vault", "/n.conduit")).resolves.toMatchObject({ mode: "new-vault" });
    const calls = restoreCalls();
    expect(calls[calls.length - 1]).toEqual([
      "cloud_backup_restore",
      { storagePath: "u1/v/1.enc", masterPassword: "pw", vaultName: "Vault", mode: "new-vault", targetPath: "/n.conduit" },
    ]);
  });

  it("latest cloud copy: the same preview, and the rollback re-run passes mode and targetPath", async () => {
    answer({ mode: "preview", preview: PREVIEW });
    await useVaultStore.getState().restoreFromCloud("pw");
    answer({ mode: "rollback", applied: 3 });
    await openPreview().apply("rollback", null);
    expect(restoreCalls().map(([ch, args]) => [ch, args])).toEqual([
      ["cloud_vault_restore", { masterPassword: "pw" }],
      ["cloud_vault_restore", { masterPassword: "pw", mode: "rollback", targetPath: null }],
    ]);
  });

  it("a vault that is not syncing here is replaced and unlocked as before (no preview)", async () => {
    useVaultStore.setState({ isUnlocked: false });
    answer({ mode: "replaced", path: "/v.conduit" });
    await useVaultStore.getState().restoreFromCloud("pw");
    expect(useSyncStore.getState().view).toBeNull();
    expect(useVaultStore.getState().isUnlocked).toBe(true);
  });

  it("a failed restore keeps the vault state and passes the error on", async () => {
    invoke.mockRejectedValue(new Error("Cloud backup restore needs the Pro or Team plan."));
    await expect(useVaultStore.getState().restoreFromBackup("u1/v/1.enc", "pw")).rejects.toThrow("Pro or Team");
    expect(useVaultStore.getState().isLoading).toBe(false);
    expect(useSyncStore.getState().view).toBeNull();
  });
});
