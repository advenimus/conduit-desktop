import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, waitFor } from "@testing-library/react";
import SyncDialogFrame, { DialogButton } from "../SyncDialogFrame";
import ConflictReviewPanel from "../ConflictReviewPanel";
import { useSyncStore } from "../../../stores/syncStore";
import { useNativeViewVisibility } from "../../../hooks/useNativeViewVisibility";
import { freezeHolders, isFrozen } from "../../../lib/native-freeze";
import { AlertTriangleIcon } from "../../../lib/icons";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const SCREENSHOT = `data:image/png;base64,${"A".repeat(200)}`;

function callsTo(channel: string) {
  return invoke.mock.calls.filter(([c]) => c === channel);
}

function TakeoverPrompt() {
  return (
    <SyncDialogFrame icon={AlertTriangleIcon} title="Take over this vault?" footer={<DialogButton onClick={() => {}}>Cancel</DialogButton>}>
      <p>Another device has this vault open.</p>
    </SyncDialogFrame>
  );
}

const syncBounds = () => Promise.resolve();

function WebSession() {
  const { shouldBeNative } = useNativeViewVisibility({ sessionId: "web-1", isActive: true, webviewReady: true, syncBounds });
  return <div data-testid="web" data-native={shouldBeNative} />;
}

beforeEach(() => {
  invoke.mockImplementation(async (channel) => {
    if (channel === "web_session_capture_and_hide") return SCREENSHOT;
    if (channel === "sync_list_conflicts") return [];
    return null;
  });
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  expect(freezeHolders()).toEqual([]);
});

describe("sync dialogs freeze native web views", () => {
  it("mounting SyncDialogFrame alone makes isFrozen() true", () => {
    expect(isFrozen()).toBe(false);
    const view = render(<TakeoverPrompt />);
    expect(isFrozen()).toBe(true);
    expect(freezeHolders()).toEqual([expect.objectContaining({ reason: "dialog", label: "Take over this vault?" })]);
    view.unmount();
    expect(isFrozen()).toBe(false);
  });

  it("hides a live web session while the sync dialog is open and restores it after", async () => {
    const view = render(<WebSession />);
    await waitFor(() => expect(callsTo("web_session_show")).toHaveLength(1));

    view.rerender(
      <>
        <WebSession />
        <TakeoverPrompt />
      </>,
    );
    await waitFor(() => expect(view.getByTestId("web").dataset.native).toBe("false"));
    await waitFor(() => expect(callsTo("web_session_capture_and_hide")).toEqual([["web_session_capture_and_hide", { sessionId: "web-1" }]]));

    view.rerender(<WebSession />);
    await waitFor(() => expect(view.getByTestId("web").dataset.native).toBe("true"));
    await waitFor(() => expect(callsTo("web_session_show")).toHaveLength(2));
  });

  it("ConflictReviewPanel holds a freeze while mounted", async () => {
    useSyncStore.setState({ conflicts: [], view: { kind: "review", row: null } });
    const view = render(<ConflictReviewPanel initialRow={null} />);
    expect(freezeHolders()).toEqual([expect.objectContaining({ reason: "dialog", label: "Review changes" })]);
    await act(async () => {});
    view.unmount();
    expect(isFrozen()).toBe(false);
  });
});
