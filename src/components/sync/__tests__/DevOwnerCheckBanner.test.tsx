import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import SyncBanners from "../SyncBanners";
import { useSyncStore } from "../../../stores/syncStore";
import { useVaultStore } from "../../../stores/vaultStore";
import type { SyncStateResponse } from "../../../types/sync";

function stateWith(ownerCheckSkipped: boolean | undefined): SyncStateResponse {
  return {
    enabled: true,
    killSwitch: false,
    vault: { lineageId: "L", path: "/cloud/Vault.conduit", fileName: "Vault.conduit", shared: true, engine: true },
    status: null,
    deviceLimit: null,
    sideFiles: [],
    notices: [],
    pendingVaults: [],
    softLocked: false,
    ownership: null,
    deviceCap: null,
    ownerCheckSkipped,
  };
}

beforeEach(() => {
  useVaultStore.setState({ lockedReason: null, isUnlocked: true, vaultType: "personal" });
  useSyncStore.setState({ openWaiting: null, deferredPrompts: new Set(), reviewBannerClosedFor: null });
});

afterEach(cleanup);

describe("dev owner check banner", () => {
  it("shows while the owner check is skipped", () => {
    useSyncStore.setState({ state: stateWith(true) });
    render(<SyncBanners />);
    expect(screen.getByText(/Owner check skipped \(dev\)/)).toBeTruthy();
  });

  it.each([false, undefined])("is hidden when the flag is %s", (flag) => {
    useSyncStore.setState({ state: stateWith(flag) });
    render(<SyncBanners />);
    expect(screen.queryByText(/Owner check skipped/)).toBeNull();
  });

  it("is hidden for a private vault, where no owner tag exists", () => {
    const state = stateWith(true);
    useSyncStore.setState({ state: { ...state, vault: state.vault && { ...state.vault, shared: false } } });
    render(<SyncBanners />);
    expect(screen.queryByText(/Owner check skipped/)).toBeNull();
  });

  it("is hidden with no personal vault open", () => {
    useVaultStore.setState({ isUnlocked: false });
    useSyncStore.setState({ state: stateWith(true) });
    render(<SyncBanners />);
    expect(screen.queryByText(/Owner check skipped/)).toBeNull();
  });
});
