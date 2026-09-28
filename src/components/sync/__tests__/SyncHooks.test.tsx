import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import ConflictFieldRow from "../ConflictFieldRow";
import ConflictItemView from "../ConflictItemView";
import RecentlyDeletedPanel from "../RecentlyDeletedPanel";
import OtherCopiesPanel from "../OtherCopiesPanel";
import MassChangeNotice from "../MassChangeNotice";
import SyncDevicesList from "../SyncDevicesList";
import SyncNoticeList from "../SyncNoticeList";
import IdleLockSetting from "../IdleLockSetting";
import EpochPromptDialog from "../EpochPromptDialog";
import TakeoverDialog from "../TakeoverDialog";
import CandidateMergeDialog from "../CandidateMergeDialog";
import { InlineError } from "../PasswordFields";
import { PendingBadge } from "../PendingVaultsWarning";
import { smallButton } from "../ConflictFieldRow";
import { useSyncStore } from "../../../stores/syncStore";
import type { ConflictVersion, FieldConflict, SyncStateResponse } from "../../../types/sync";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

beforeEach(() => {
  invoke.mockResolvedValue(null);
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

function answer(channels: Readonly<Record<string, unknown>>): void {
  invoke.mockImplementation(async (channel) => channels[channel] ?? null);
}

async function settle(): Promise<void> {
  await act(async () => {});
}

const all = (css: string) => [...document.querySelectorAll<HTMLElement>(css)];
const texts = (css: string) => all(css).map((el) => el.textContent?.trim());

function version(id: string, value: string, provisional: boolean): ConflictVersion {
  return { id, source: { kind: "device", deviceUuid: id, deviceName: id }, timeMs: 0, value, masked: false, provisional, undecryptable: false, redacted: false, olderApp: false };
}

const hostField: FieldConflict = {
  key: { tbl: 1, rowId: "e1", reg: "host" },
  label: "Host",
  cls: "prompt",
  secret: false,
  versions: [version("a", "10.0.0.5", true), version("b", "10.0.0.9", false)],
  staleRevert: false,
  keepBothOffered: true,
  invariantGuard: false,
  snoozeKey: "s",
};

describe("review rows (B11, B47)", () => {
  it("marks the field row and its label, and keeps each value, its In use now badge and its Use this in one version line", () => {
    render(<ConflictFieldRow field={hostField} itemTitle="Prod" />);
    const row = document.querySelector("[data-cv-review-field]") as HTMLElement;
    expect(row.querySelector("[data-cv-review-field-label]")).toHaveTextContent("Host");
    const lines = all("[data-cv-review-version]");
    expect(lines).toHaveLength(2);
    for (const button of screen.getAllByRole("button", { name: "Use this" })) {
      expect(button.closest("[data-cv-review-field]")).toBe(row);
      expect(lines).toContain(button.closest("[data-cv-review-version]"));
    }
    expect(lines[0]?.querySelector("[data-cv-review-value]")).toHaveTextContent("10.0.0.5");
    expect(lines[0]).toHaveTextContent("In use now");
    expect(lines[1]?.querySelector("[data-cv-review-value]")).toHaveTextContent("10.0.0.9");
    expect(lines[1]).not.toHaveTextContent("In use now");
  });

  it("keeps every action label", () => {
    render(<ConflictFieldRow field={hostField} itemTitle="Prod" />);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Use this", "Use this", "Enter a different value...", "Keep both", "Decide later"]);
  });

  it("gives the other conflict kinds the same row and label hooks", () => {
    render(<ConflictItemView item={{ kind: "edit-delete", row: { tbl: 1, rowId: "e1" }, deleted: [version("a", "", false)], edited: [version("b", "", false)], snoozeKey: "sk" }} title="Prod" />);
    expect(document.querySelector("[data-cv-review-field] [data-cv-review-field-label]")).toHaveTextContent("Deleted and edited");
  });

  it("draws the appearance choices as radios labeled by their text (B46)", () => {
    const color: FieldConflict = { ...hostField, key: { tbl: 1, rowId: "e1", reg: "color" }, label: "Color", versions: [version("a", "red", true), version("b", "blue", false)] };
    render(<ConflictItemView item={{ kind: "appearance", row: { tbl: 1, rowId: "e1" }, fields: [color], newest: { color: "a" }, snoozeKey: "sk" }} title="Prod" />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    for (const radio of radios) expect(radio.closest("label")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
  });
});

describe("Recently deleted rows (B18, B35)", () => {
  it("shows Loading... as visible text, then marks the list, each row's title and detail", async () => {
    let finish: (items: unknown) => void = () => {};
    invoke.mockImplementation((channel) => (channel === "sync_recently_deleted" ? new Promise((r) => (finish = r)) : Promise.resolve(null)));
    render(<RecentlyDeletedPanel />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    await act(async () => finish([{ row: { tbl: 1, rowId: "a" }, title: "db-prod", entryType: "ssh", diedMs: Date.now() - 120_000, deviceName: "MacBook", redacted: false }]));
    const row = document.querySelector("[data-cv-deleted-list] label") as HTMLElement;
    expect(row.querySelector("[data-cv-row-title]")).toHaveTextContent("db-prod");
    expect(row.querySelector("[data-cv-row-detail]")?.textContent).toMatch(/^Deleted .* on MacBook · ssh$/);
    expect(row.querySelector("input[type=checkbox]")).not.toBeNull();
    expect(screen.getByText("Show items deleted more than 30 days ago").closest("label")?.querySelector("input[type=checkbox]")).not.toBeNull();
  });
});

describe("Other copies rows (B20, B35)", () => {
  it("shows Looking for copies... as visible text, then marks each row, its title (with the path) and its detail", async () => {
    let finish: (items: unknown) => void = () => {};
    invoke.mockImplementation((channel) => (channel === "sync_list_copies" ? new Promise((r) => (finish = r)) : Promise.resolve(null)));
    render(<OtherCopiesPanel />);
    expect(screen.getByText("Looking for copies...")).toBeInTheDocument();
    await act(async () => finish([{ path: "/v/Vault 2.conduit", name: "Vault 2.conduit", sha256: "x", cls: "nothing-new", changes: 0, deletions: 0 }]));
    const row = document.querySelector("[data-cv-copy-row]") as HTMLElement;
    const title = row.querySelector("[data-cv-row-title]");
    expect(title).toHaveTextContent("Vault 2.conduit");
    expect(title).toHaveAttribute("title", "/v/Vault 2.conduit");
    expect(row.querySelector("[data-cv-row-detail]")).toHaveTextContent("Nothing new. Everything in it is already in your vault.");
    expect([...row.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Move to Trash", "Ignore"]);
    expect(screen.getByRole("button", { name: "Scan again" })).toBeInTheDocument();
  });
});

describe("mass change rows (B21)", () => {
  it("marks each row's title inside its checkbox label", async () => {
    answer({
      sync_list_snapshots: [{ id: "s1", createdMs: 0, noticeId: "n1", deleted: 2, changedRows: 0, byDeviceName: "MacBook" }],
      sync_undo_preview: {
        snapshotId: "s1",
        rows: [
          { row: { tbl: 1, rowId: "a" }, title: "db-prod", stillDeleted: true },
          { row: { tbl: 1, rowId: "b" }, title: "web-01", stillDeleted: false },
        ],
        fields: [],
      },
    });
    render(<MassChangeNotice noticeId="n1" />);
    expect(await screen.findByRole("dialog", { name: "MacBook deleted 2 items." })).toBeInTheDocument();
    const labels = all("[role=dialog] label");
    expect(labels.map((l) => l.querySelector("[data-cv-row-title]")?.textContent)).toEqual(["db-prod", "web-01"]);
    expect(labels.map((l) => (l.querySelector("input") as HTMLInputElement).checked)).toEqual([true, false]);
    expect(labels[1]).toHaveTextContent("(already back)");
  });
});

describe("devices and notices (B5, B6, B38)", () => {
  it("marks each device row, its name and its line", async () => {
    answer({
      sync_list_devices: [
        { deviceUuid: "1", name: "MacBook", platform: "darwin", appVersion: null, thisDevice: true, sessionOpen: true, lastActiveMs: null, fileHint: null, server: null },
        { deviceUuid: "2", name: "iPhone", platform: "ios", appVersion: null, thisDevice: false, sessionOpen: false, lastActiveMs: null, fileHint: null, server: null },
      ],
    });
    render(<SyncDevicesList />);
    await settle();
    expect(all("[data-cv-device-row]")).toHaveLength(2);
    expect(texts("[data-cv-device-name]")).toEqual(["MacBook (this device)", "iPhone"]);
    expect(texts("[data-cv-device-line]")).toEqual(["Open now", "Closed"]);
  });

  it("marks each notice and its text, with Review for a mass change and OK", () => {
    const state = { notices: [{ id: "n1", kind: "mass-change", key: null, createdMs: 0, sourceSha256: null, count: 42 }] } as unknown as SyncStateResponse;
    useSyncStore.setState({ state });
    render(<SyncNoticeList />);
    const notice = document.querySelector("[data-cv-sync-notice]") as HTMLElement;
    expect(notice.querySelector("[data-cv-sync-notice-text]")?.textContent).not.toBe("");
    expect([...notice.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Review", "OK"]);
    useSyncStore.setState({ state: null });
  });
});

describe("idle lock (B28)", () => {
  it("keeps the select's accessible name", () => {
    render(<IdleLockSetting minutes={0} onChange={vi.fn()} />);
    expect(document.querySelector('select[aria-label="Lock the vault when idle"]')).not.toBeNull();
  });
});

describe("busy texts, errors and radios (B8, B35, B46)", () => {
  it("[Use here instead] reads Opening... while busy", () => {
    render(
      <TakeoverDialog payload={{ code: "VAULT_OPEN_ELSEWHERE", holders: [], limit: 3, fileName: "Vault", locationDiffers: false, via: "server" }} busy onUseHere={vi.fn()} onCancel={vi.fn()} />,
    );
    const button = screen.getByRole("button", { name: "Opening..." });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("the password prompt has labeled fields, text radios, a submit Continue and reads Checking... while it checks", async () => {
    let finish: (value: unknown) => void = () => {};
    invoke.mockImplementation((channel) => (channel === "sync_resolve_concurrent_epoch" ? new Promise((r) => (finish = r)) : Promise.resolve(null)));
    render(<EpochPromptDialog prompt={{ kind: "epoch-concurrent", id: "e1", epochIds: ["own", "other"] }} />);
    const label = screen.getByText("Other device's password").closest("label") as HTMLElement;
    expect(label.querySelector("span")?.textContent).toBe("Other device's password");
    const input = label.querySelector("input") as HTMLInputElement;
    expect(screen.getByText("The one I use on this device").closest("label")?.querySelector("input[type=radio]")).not.toBeNull();
    expect(screen.getByText("The other device's password").closest("label")?.querySelector("input[type=radio]")).not.toBeNull();
    await act(async () => {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "secret");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = document.querySelector("[data-dialog-content] form button[type=submit]") as HTMLButtonElement;
    expect(submit).toHaveTextContent("Continue");
    await act(async () => submit.click());
    expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
    await act(async () => finish({ ok: false, reason: "wrong-password" }));
    expect(document.querySelector("[data-cv-error]")).toHaveTextContent("That password didn't work.");
  });

  it("InlineError is a danger callout whose text carries data-cv-error", () => {
    render(<InlineError message="That password didn't work." />);
    expect(document.querySelector("p[data-cv-error]")).toHaveTextContent("That password didn't work.");
  });

  it("the candidate preview shows Comparing... as visible text", () => {
    invoke.mockImplementation(() => new Promise(() => {}));
    render(<CandidateMergeDialog candidateId="c1" confirmSideFilesAfter={false} />);
    expect(screen.getByText("Comparing...")).toBeInTheDocument();
  });
});

describe("leftovers", () => {
  it("the hub's pending badge is a warning Badge with its title", () => {
    useSyncStore.setState({ state: { pendingVaults: [{ lineageId: "L", sharedPath: "/v/Vault.conduit", fileName: "Vault.conduit" }] } as unknown as SyncStateResponse });
    render(<PendingBadge vaultPath="/v/Vault.conduit" />);
    const badge = screen.getByText("Changes not yet synced");
    expect(badge).toHaveAttribute("title", "Unlock this vault to sync them");
    expect(badge.className).toContain("text-warning");
    expect(badge.className).not.toMatch(/amber|text-\[10px\]/);
    useSyncStore.setState({ state: null });
  });

  it("smallButton keeps the Button sm look for plain buttons outside this directory", () => {
    expect(smallButton(true)).toContain("bg-btn-primary");
    expect(smallButton()).toContain("h-control-sm");
    expect(smallButton()).not.toMatch(/conduit|bg-raised/);
  });
});
