import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/electron", () => ({
  invoke: vi.fn(async () => ({})),
  listenSync: vi.fn(() => () => undefined),
}));

const { useEntryStore } = await import("../../../stores/entryStore");
const { useArticleTabsStore } = await import("../../../stores/articleTabsStore");
const { useSessionStore } = await import("../../../stores/sessionStore");
const { default: DashboardSubTabs } = await import("../DashboardSubTabs");

const HOST = "dashboard::a1";
const article = (id: string, name: string) => ({
  id, name, entry_type: "document", folder_id: null, parent_entry_id: "a1", sort_order: 0, host: null, port: null,
  credential_id: null, username: null, domain: null, icon: null, color: null, tags: [], is_favorite: false, notes: null,
  credential_type: null, created_at: "x", updated_at: new Date().toISOString(),
  config: { content: `body of ${name}`, kb: { v: 1, scope: "asset", kind: "procedure", summary: "", pinned: false, status: "active", author: { kind: "user" } } },
});

beforeEach(() => {
  act(() => {
    useEntryStore.setState({ entries: [], hiddenEntries: [article("k1", "Restart"), article("k2", "Backups")] as never[], folders: [] });
    useSessionStore.setState({ sessions: [{ id: HOST, type: "dashboard", title: "web (Info)", status: "connected", entryId: "a1" }] } as never);
    useArticleTabsStore.setState({ byHost: {} });
  });
});

const ui = () =>
  render(
    <DashboardSubTabs host={HOST} homeLabel="Info" visible>
      <p>asset details</p>
    </DashboardSubTabs>,
  );

describe("DashboardSubTabs", () => {
  it("shows only the dashboard until an article is opened", () => {
    ui();
    expect(screen.queryByRole("tablist", { name: "Open articles" })).not.toBeInTheDocument();
    expect(screen.getByText("asset details")).toBeInTheDocument();
  });

  it("switches between the dashboard and open articles, and closes them like browser tabs", () => {
    act(() => {
      useArticleTabsStore.getState().openTab(HOST, "k1");
      useArticleTabsStore.getState().openTab(HOST, "k2");
    });
    ui();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Info", "Restart", "Backups"]);
    expect(screen.getByText("body of Backups")).toBeVisible();

    fireEvent.click(screen.getByText("Info"));
    expect(screen.getByText("asset details").parentElement).not.toHaveClass("hidden");
    fireEvent.click(screen.getByText("Restart"));
    expect(screen.getByText("body of Restart")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close Restart" }));
    expect(useArticleTabsStore.getState().byHost[HOST]).toEqual({ open: ["k2"], active: "k2" });
    fireEvent.click(screen.getByRole("button", { name: "Close Backups" }));
    expect(useArticleTabsStore.getState().byHost[HOST]).toEqual({ open: [], active: null });
    expect(screen.queryByRole("tablist", { name: "Open articles" })).not.toBeInTheDocument();
  });

  it("forgets a closed dashboard tab's articles", () => {
    act(() => useArticleTabsStore.getState().openTab(HOST, "k1"));
    act(() => useSessionStore.setState({ sessions: [] } as never));
    expect(useArticleTabsStore.getState().byHost[HOST]).toBeUndefined();
  });
});
