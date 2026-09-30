import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import type { ReactElement } from "react";
import SyncDialogFrame, { DialogButton } from "../SyncDialogFrame";
import ConflictReviewPanel from "../ConflictReviewPanel";
import CandidateMergeDialog from "../CandidateMergeDialog";
import DamagedWorkingCopyDialog from "../DamagedWorkingCopyDialog";
import DifferentCopiesDialog from "../DifferentCopiesDialog";
import DisplacedDialog, { DisplacingOverlay } from "../DisplacedDialog";
import EpochPromptDialog from "../EpochPromptDialog";
import MassChangeNotice from "../MassChangeNotice";
import OtherCopiesPanel from "../OtherCopiesPanel";
import PasswordChangedElsewhereDialog from "../PasswordChangedElsewhereDialog";
import RecentlyDeletedPanel from "../RecentlyDeletedPanel";
import RestorePreviewDialog from "../RestorePreviewDialog";
import SessionConflictDialog from "../SessionConflictDialog";
import TakeoverDialog from "../TakeoverDialog";
import WaitingForDriveDialog from "../WaitingForDriveDialog";
import { useSyncStore } from "../../../stores/syncStore";
import { freezeHolders } from "../../../lib/native-freeze";
import { clickScrim, closeButton, pressEscape, topPanel } from "../../common/__tests__/dialogClose";
import type { RecentlyDeletedItem } from "../../../types/sync";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

const LISTS: Readonly<Record<string, unknown>> = {
  sync_recently_deleted: [],
  sync_list_copies: [],
  sync_list_snapshots: [],
  sync_list_conflicts: [],
};

beforeEach(() => {
  invoke.mockImplementation(async (channel) => LISTS[channel] ?? null);
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useSyncStore.setState({ view: { kind: "recently-deleted" }, displaced: null, sessionConflict: null, conflicts: [] });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  expect(freezeHolders()).toEqual([]);
});

const holder = { deviceId: "d", deviceName: "MacBook", platform: "darwin", fileName: null, fileId: null, location: null, lastActiveMs: null, busySessions: 0, busyJobs: 0 };
const hint = { file_id: "f", location: "icloud:Docs", file_name: "Vault.conduit" };
const displacedEvent = { lineageId: "L", reason: "yielded", byDeviceName: "iPhone", openConnections: 0, runningJobs: 0, changesSaved: true, fileName: null, minVersion: null, released: false, deviceCap: null } as const;
const waiting = { purpose: "stale-file", devices: [{ deviceId: "d", deviceName: "MacBook", savedAtMs: null }], blocking: true, stopOffered: false, sinceMs: 0 } as const;

interface EscapeCase {
  readonly title: string;
  readonly render: (onCancel: () => void) => ReactElement;
  /** How Escape shows up: the cancel callback, or a store or IPC effect. */
  readonly closed: (onCancel: ReturnType<typeof vi.fn>) => Promise<void> | void;
}

const viewClosed = () => expect(useSyncStore.getState().view).toBeNull();

/** The ten dialogs of 3.12.1 whose Escape runs their onEscape. */
const ESCAPE_RUNS: readonly EscapeCase[] = [
  { title: "Merge a copy", render: () => <CandidateMergeDialog candidateId="c1" confirmSideFilesAfter={false} />, closed: viewClosed },
  {
    title: "This computer's copy is damaged",
    render: (c) => <DamagedWorkingCopyDialog fileName="Vault" recoverable busy={false} onRecover={vi.fn()} onCancel={c} />,
    closed: (c) => expect(c).toHaveBeenCalledTimes(1),
  },
  {
    title: "Two copies of this vault",
    render: () => <DifferentCopiesDialog prompt={{ kind: "different-copies", id: "p1", deviceUuid: "u", deviceName: "MacBook", theirs: hint, ours: hint }} />,
    closed: () => waitFor(() => expect(invoke).toHaveBeenCalledWith("sync_dismiss_prompt", { promptId: "p1" })),
  },
  {
    title: "Vault locked",
    render: () => {
      useSyncStore.setState({ displaced: displacedEvent });
      return <DisplacedDialog event={displacedEvent} />;
    },
    closed: () => expect(useSyncStore.getState().displaced).toBeNull(),
  },
  { title: "Large change from a sync", render: () => <MassChangeNotice noticeId="n1" />, closed: viewClosed },
  { title: "Other copies of this vault", render: () => <OtherCopiesPanel />, closed: viewClosed },
  {
    title: "Master password changed",
    render: (c) => (
      <PasswordChangedElsewhereDialog
        payload={{ code: "VAULT_PASSWORD_CHANGED_ELSEWHERE", changedByDeviceName: "MacBook", changedMs: 0, needsPreviousPassword: false, deleteBiometric: false }}
        busy={false}
        error={null}
        onSubmit={vi.fn()}
        onCancel={c}
      />
    ),
    closed: (c) => expect(c).toHaveBeenCalledTimes(1),
  },
  { title: "Recently deleted", render: () => <RecentlyDeletedPanel />, closed: viewClosed },
  {
    title: "Restore from backup",
    render: () => <RestorePreviewDialog preview={{ deletions: [], restorations: [], replacements: [], unreadableSecrets: 0 }} apply={vi.fn()} />,
    closed: viewClosed,
  },
  {
    title: "Vault open on another device",
    render: (c) => (
      <TakeoverDialog payload={{ code: "VAULT_OPEN_ELSEWHERE", holders: [holder], limit: 3, fileName: "Vault", locationDiffers: false, via: "server", cause: "vault_limit", deviceCap: null, displaceDeviceName: null, alsoLockDeviceName: null }} busy={false} onUseHere={vi.fn()} onCancel={c} />
    ),
    closed: (c) => expect(c).toHaveBeenCalledTimes(1),
  },
];

/** The dialogs that swallow Escape: a password prompt, a countdown, a blocking wait and the saving overlay. */
const ESCAPE_SWALLOWED: readonly { readonly title: string; readonly render: () => ReactElement }[] = [
  { title: "Syncing paused", render: () => <EpochPromptDialog prompt={{ kind: "epoch-newer", id: "e1", changedByDeviceName: "MacBook", changedMs: 0 }} /> },
  { title: "Also open on MacBook", render: () => <SessionConflictDialog event={{ lineageId: "L", holders: [holder], answerByMs: Date.now() + 30_000, cause: "vault_limit", deviceCap: null }} /> },
  { title: "Getting the latest changes", render: () => <WaitingForDriveDialog waiting={waiting} duringUnlock /> },
  { title: "Locking this vault here", render: () => <DisplacingOverlay event={{ lineageId: "L", reason: "yielded", byDeviceName: "iPhone" }} /> },
];

async function settle(): Promise<void> {
  await act(async () => {});
}

describe("SyncDialogFrame (spec 3.12.1, 4.8)", () => {
  it("is a sync-layer Dialog named by its title, in place, with no close button", () => {
    const { container } = render(
      <SyncDialogFrame icon="key" title="Take over this vault?" footer={<DialogButton onClick={() => {}}>Cancel</DialogButton>}>
        <p>Body</p>
      </SyncDialogFrame>,
    );
    const panel = topPanel();
    expect(panel).toHaveAttribute("role", "dialog");
    expect(panel).toHaveAttribute("aria-label", "Take over this vault?");
    expect(panel.querySelector("h2")).toHaveTextContent("Take over this vault?");
    expect(panel.parentElement).toHaveAttribute("data-cv-layer", "sync");
    expect(container.contains(panel)).toBe(true);
    expect(panel).toHaveStyle({ maxWidth: "440px" });
    expect(closeButton()).toBeNull();
    expect(panel.querySelector("[data-cv-dialog-footer]")).toHaveTextContent("Cancel");
  });

  it("draws no button row for footer null", () => {
    render(
      <SyncDialogFrame icon="lock" title="Saving" footer={null}>
        <p>Saving your last changes...</p>
      </SyncDialogFrame>,
    );
    expect(topPanel().querySelector("[data-cv-dialog-footer]")).toBeNull();
  });

  it("runs onSubmit from a submit button inside one form (B31)", () => {
    const onSubmit = vi.fn();
    render(
      <SyncDialogFrame icon="key" title="Form" onSubmit={onSubmit} footer={<DialogButton type="submit">Go</DialogButton>}>
        <input aria-label="field" />
      </SyncDialogFrame>,
    );
    expect(topPanel().querySelector("form button[type=submit]")).toHaveTextContent("Go");
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("sync dialogs whose Escape runs onEscape (3.12.1)", () => {
  it.each(ESCAPE_RUNS)("$title: Escape closes it, a scrim click does not, and it has no close button", async ({ title, render: show, closed }) => {
    const onCancel = vi.fn();
    render(show(onCancel));
    await settle();
    expect(topPanel()).toHaveAttribute("aria-label", title);
    expect(topPanel().parentElement).toHaveAttribute("data-cv-layer", "sync");
    expect(closeButton()).toBeNull();
    clickScrim();
    expect(onCancel).not.toHaveBeenCalled();
    expect(useSyncStore.getState().view).not.toBeNull();
    pressEscape();
    await closed(onCancel);
  });
});

describe("sync dialogs that swallow Escape (3.12.1)", () => {
  it.each(ESCAPE_SWALLOWED)("$title: Escape and a scrim click leave it open, and nothing underneath hears the Escape", async ({ title, render: show }) => {
    const underneath = vi.fn();
    document.addEventListener("keydown", underneath);
    render(show());
    await settle();
    expect(topPanel()).toHaveAttribute("aria-label", title);
    expect(closeButton()).toBeNull();
    pressEscape();
    clickScrim();
    await settle();
    expect(screen.getByRole("dialog", { name: title })).toBeInTheDocument();
    expect(underneath).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map(([c]) => c)).not.toContain("sync_dismiss_prompt");
    document.removeEventListener("keydown", underneath);
  });
});

describe("Review changes (3.12.1, B12)", () => {
  it("is a sync-layer dialog labeled Review changes; Escape and its Close button close it, a scrim click does not", async () => {
    useSyncStore.setState({ view: { kind: "review", row: null } });
    render(<ConflictReviewPanel initialRow={null} />);
    await settle();
    const panel = topPanel();
    expect(panel).toHaveAttribute("aria-label", "Review changes");
    expect(panel.parentElement).toHaveAttribute("data-cv-layer", "sync");
    expect(panel).toHaveStyle({ maxWidth: "896px" });
    clickScrim();
    expect(useSyncStore.getState().view).not.toBeNull();
    pressEscape();
    expect(useSyncStore.getState().view).toBeNull();

    useSyncStore.setState({ view: { kind: "review", row: null } });
    const button = closeButton();
    expect(button).not.toBeNull();
    fireEvent.click(button as HTMLButtonElement);
    expect(useSyncStore.getState().view).toBeNull();
  });

  it("keeps the header controls in today's order: the title, the two bulk buttons, then Close", async () => {
    render(<ConflictReviewPanel initialRow={null} />);
    await settle();
    const header = topPanel().querySelector("h2")?.parentElement as HTMLElement;
    const controls = [...header.querySelectorAll("h2, button")].map((el) => el.getAttribute("aria-label") ?? el.textContent);
    expect(controls).toEqual(["Review changes", "Keep newest for all", "Keep newest for older-app changes", "Close"]);
  });
});

describe("the delete confirm inside Recently deleted (3.12.1, B19)", () => {
  const erasable: RecentlyDeletedItem = { row: { tbl: 1, rowId: "a" }, title: "item a", entryType: "ssh", diedMs: Date.now(), deviceName: null, redacted: false };

  async function openConfirm(): Promise<void> {
    invoke.mockImplementation(async (channel) => (channel === "sync_recently_deleted" ? [erasable] : null));
    render(<RecentlyDeletedPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete all permanently" }));
  }

  it("stacks above the panel on the stacked layer, without the old z-[70] wrapper", async () => {
    await openConfirm();
    const confirm = topPanel();
    expect(confirm.querySelector("h2")).toHaveTextContent("Delete permanently?");
    expect(confirm.parentElement).toHaveAttribute("data-cv-layer", "stacked");
    expect(document.querySelector('[data-cv-layer="stacked"] [data-dialog-content] button')).not.toBeNull();
    expect(document.querySelector(".z-\\[70\\]")).toBeNull();
  });

  it("Escape cancels only the confirm; the panel stays open", async () => {
    await openConfirm();
    pressEscape();
    expect(screen.queryByText("Delete permanently?")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Recently deleted" })).toBeInTheDocument();
    expect(useSyncStore.getState().view).not.toBeNull();
    pressEscape();
    expect(useSyncStore.getState().view).toBeNull();
  });
});
