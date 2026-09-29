import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchVaultForStartupStatus } from "../startup-vault-events";
import { useVaultStore } from "../../stores/vaultStore";
import { useStartupVaultStore, type StartupStatus } from "../../stores/startupVaultStore";

const VAULT = "/v/Work.conduit";
let unlocked = false;
const invoke = vi.fn(async (channel: string): Promise<unknown> => (channel === "auto_unlock_status" ? status(unlocked) : undefined));
const nextTask = () => new Promise<void>((r) => setTimeout(r, 1));
let unwatch: () => void = () => {};

function status(currentOn: boolean): StartupStatus {
  return { platform: "darwin", store: { usable: true, reason: "ok", storeName: "system keychain" }, startupVault: { kind: "personal", path: VAULT, lineageId: "L1" }, savedPath: VAULT, currentOn };
}

beforeEach(() => {
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useVaultStore.setState({ isUnlocked: false, currentVaultPath: VAULT, vaultType: "personal" });
  useStartupVaultStore.setState({ status: status(false) });
  unwatch = watchVaultForStartupStatus();
});

afterEach(() => {
  unwatch();
  invoke.mockClear();
});

describe("the quiet indicator follows every unlock and lock (docs/AUTO_UNLOCK.md 2.7)", () => {
  it("a typed unlock after a lock brings currentOn back; a lock clears it", async () => {
    unlocked = true;
    useVaultStore.setState({ isUnlocked: true });
    await nextTask();
    expect(useStartupVaultStore.getState().status?.currentOn).toBe(true);
    unlocked = false;
    useVaultStore.setState({ isUnlocked: false });
    await nextTask();
    expect(useStartupVaultStore.getState().status?.currentOn).toBe(false);
  });

  it("ignores vault store changes that are not an unlock, a lock or a switch", async () => {
    useVaultStore.setState({ isLoading: true });
    await nextTask();
    expect(invoke).not.toHaveBeenCalled();
  });
});
