import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import RecentlyDeletedPanel from "../RecentlyDeletedPanel";
import type { RecentlyDeletedItem } from "../../../types/sync";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

function item(id: string, redacted: boolean): RecentlyDeletedItem {
  return { row: { tbl: 1, rowId: id }, title: `item ${id}`, entryType: "ssh", diedMs: Date.now() - 60_000, deviceName: null, redacted };
}

function showList(items: readonly RecentlyDeletedItem[]): void {
  invoke.mockImplementation(async (channel) => (channel === "sync_recently_deleted" ? items : null));
  render(<RecentlyDeletedPanel />);
}

const eraseAll = () => screen.getByRole("button", { name: "Delete all permanently" });

beforeEach(() => {
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("RecentlyDeletedPanel", () => {
  it("disables Delete all permanently when every row is already erased", async () => {
    showList([item("a", true), item("b", true)]);
    expect(await screen.findByText("item a")).toBeInTheDocument();
    expect(eraseAll()).toBeDisabled();
  });

  it("enables it while one row can still be erased", async () => {
    showList([item("a", true), item("b", false)]);
    expect(await screen.findByText("item b")).toBeInTheDocument();
    expect(eraseAll()).toBeEnabled();
  });

  it("disables it for an empty list", async () => {
    showList([]);
    expect(await screen.findByText("Nothing was deleted recently.")).toBeInTheDocument();
    expect(eraseAll()).toBeDisabled();
  });
});
