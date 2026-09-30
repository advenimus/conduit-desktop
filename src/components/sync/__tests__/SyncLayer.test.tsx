import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import SyncLayer from "../SyncLayer";
import TakeoverDialog from "../TakeoverDialog";
import { useSyncStore } from "../../../stores/syncStore";
import type { OpenErrorPayload } from "../../../types/sync";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

beforeEach(() => {
  invoke.mockResolvedValue(null);
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useSyncStore.setState({ state: null, displaced: null, displacing: null, sessionConflict: null, openWaiting: null, view: null, takeoverMode: false });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("SyncLayer", () => {
  it("shows the soft-lock notice and [Use here instead] asks for a take-over unlock", () => {
    const onUnlock = vi.fn();
    document.addEventListener("conduit:unlock-vault", onUnlock);
    useSyncStore.setState({
      displaced: { lineageId: "L", reason: "takeover", byDeviceName: "iPhone", openConnections: 2, runningJobs: 0, changesSaved: true, fileName: null },
    });
    render(<SyncLayer />);
    expect(screen.getByText("This vault is now open on iPhone.")).toBeInTheDocument();
    expect(screen.getByText("Your 2 open connections are still running.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Use here instead"));
    expect(useSyncStore.getState().takeoverMode).toBe(true);
    expect(useSyncStore.getState().displaced).toBeNull();
    expect(onUnlock).toHaveBeenCalledTimes(1);
    document.removeEventListener("conduit:unlock-vault", onUnlock);
  });

  it("shows the unlock-time wait with Continue anyway", () => {
    useSyncStore.setState({
      openWaiting: { purpose: "first-genesis", devices: [{ deviceId: "d", deviceName: "MacBook", savedAtMs: null }], blocking: false, stopOffered: true, sinceMs: 0 },
    });
    render(<SyncLayer />);
    expect(screen.getByText("Waiting for the synced vault from MacBook...")).toBeInTheDocument();
    expect(screen.queryByText(/Stop waiting/)).toBeNull();
    fireEvent.click(screen.getByText("Continue anyway"));
    expect(invoke).toHaveBeenCalledWith("vault_session_open_now", undefined);
  });
});

describe("SyncLayer stacking (spec 6.8, 7.2)", () => {
  const conflict = {
    lineageId: "L",
    holders: [{ deviceId: "d", deviceName: "MacBook", platform: "darwin", fileName: null, fileId: null, location: null, lastActiveMs: null, busySessions: 0, busyJobs: 0 }],
    answerByMs: Date.now() + 30_000,
  };

  it("shows the saving overlay while a displaced device saves, then the soft-lock notice", () => {
    useSyncStore.setState({ displacing: { lineageId: "L", reason: "takeover", byDeviceName: "iPhone" } });
    const { rerender } = render(<SyncLayer />);
    expect(screen.getByText("Opened on iPhone")).toBeInTheDocument();
    expect(screen.getByText("Saving your last changes...")).toBeInTheDocument();
    useSyncStore.getState().setDisplaced({ lineageId: "L", reason: "takeover", byDeviceName: "iPhone", openConnections: 0, runningJobs: 0, changesSaved: true, fileName: null });
    rerender(<SyncLayer />);
    expect(screen.queryByText("Saving your last changes...")).toBeNull();
    expect(screen.getByText("This vault is now open on iPhone.")).toBeInTheDocument();
  });

  it("paints the timed session-conflict dialog above an open panel", () => {
    invoke.mockImplementation((c: string) => Promise.resolve(c === "sync_recently_deleted" ? [] : null));
    useSyncStore.setState({ view: { kind: "recently-deleted" }, sessionConflict: conflict });
    const { container } = render(<SyncLayer />);
    const labels = [...container.children].map((el) => el.querySelector("[role=dialog]")?.getAttribute("aria-label"));
    expect(labels.indexOf("Also open on MacBook")).toBeGreaterThan(labels.indexOf("Recently deleted"));
  });

  it("a list that fails to load says so and offers another try instead of looking empty", async () => {
    invoke.mockImplementation((c: string) => (c === "sync_recently_deleted" ? Promise.reject(new Error("Sync could not finish that. Try again.")) : Promise.resolve(null)));
    useSyncStore.setState({ view: { kind: "recently-deleted" } });
    render(<SyncLayer />);
    expect(await screen.findByText("Could not load the deleted items.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing was deleted recently.")).toBeNull();
    invoke.mockImplementation((c: string) => Promise.resolve(c === "sync_recently_deleted" ? [] : null));
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("Nothing was deleted recently.")).toBeInTheDocument();
  });

  it("Escape closes the top sync panel and never reaches the dialog underneath", () => {
    invoke.mockImplementation((c: string) => Promise.resolve(c === "sync_recently_deleted" ? [] : null));
    const settingsKeyDown = vi.fn();
    useSyncStore.setState({ view: { kind: "recently-deleted" } });
    render(
      <div onKeyDown={settingsKeyDown}>
        <button type="button">Recently deleted</button>
        <SyncLayer />
      </div>,
    );
    const opener = screen.getByRole("button", { name: "Recently deleted" });
    opener.focus();
    fireEvent.keyDown(opener, { key: "Escape" });
    expect(useSyncStore.getState().view).toBeNull();
    expect(settingsKeyDown).not.toHaveBeenCalled();
  });
});

describe("TakeoverDialog", () => {
  const payload: Extract<OpenErrorPayload, { code: "VAULT_OPEN_ELSEWHERE" }> = {
    code: "VAULT_OPEN_ELSEWHERE",
    holders: [{ deviceId: "d", deviceName: "Chris's MacBook", platform: "darwin", fileName: null, fileId: null, location: "icloud:Docs", lastActiveMs: null, busySessions: 3, busyJobs: 1 }],
    limit: 1,
    fileName: "Vault.conduit",
    locationDiffers: true,
    via: "server",
  };

  it("words the holder, the busy sessions and the Free rule, with Upgrade", () => {
    const onUseHere = vi.fn();
    render(<TakeoverDialog payload={payload} busy={false} onUseHere={onUseHere} onCancel={vi.fn()} />);
    expect(screen.getByText("This vault is open on Chris's MacBook.")).toBeInTheDocument();
    expect(screen.getByText(/has 3 open connections and an AI task running/)).toBeInTheDocument();
    expect(screen.getByText(/iCloud Drive/)).toBeInTheDocument();
    expect(screen.getByText("Upgrade to Pro")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Use here instead"));
    expect(onUseHere).toHaveBeenCalled();
  });

  it("hides the Free wording and Upgrade on unlimited plans", () => {
    render(<TakeoverDialog payload={{ ...payload, limit: 3 }} busy={false} onUseHere={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText("Upgrade to Pro")).toBeNull();
    expect(screen.queryByText(/On the Free plan/)).toBeNull();
  });
});
