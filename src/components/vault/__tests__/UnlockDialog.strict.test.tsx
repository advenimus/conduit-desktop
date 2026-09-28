import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import UnlockDialog from "../UnlockDialog";
import { useSyncStore } from "../../../stores/syncStore";
import { useVaultStore } from "../../../stores/vaultStore";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

const nextTask = () => act(() => new Promise<void>((r) => setTimeout(r, 5)));

beforeEach(() => {
  invoke.mockResolvedValue(false);
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useVaultStore.setState({ vaultExists: true, currentVaultPath: "/cloud/Vault.conduit", error: null, isLoading: false });
  useSyncStore.setState({ openError: null, takeoverMode: false });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("UnlockDialog take-over request under StrictMode", () => {
  it("keeps the take-over request it was opened with (StrictMode re-runs effects on mount)", async () => {
    useSyncStore.setState({ takeoverMode: true });
    render(
      <StrictMode>
        <UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />
      </StrictMode>,
    );
    await nextTask();
    expect(useSyncStore.getState().takeoverMode).toBe(true);
    expect(screen.getByText("Unlock to use this vault here. It locks on the other device.")).toBeInTheDocument();
  });

  it("forgets the take-over request and the sync error once the dialog closes", async () => {
    useSyncStore.setState({ takeoverMode: true });
    const { unmount } = render(
      <StrictMode>
        <UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />
      </StrictMode>,
    );
    await nextTask();
    useSyncStore.setState({ openError: { code: "VAULT_FILE_UNREADABLE", fileName: "Vault.conduit" } as never });
    unmount();
    await nextTask();
    expect(useSyncStore.getState().takeoverMode).toBe(false);
    expect(useSyncStore.getState().openError).toBeNull();
  });
});
