import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/electron", () => ({
  invoke: vi.fn(async () => ({})),
  listenSync: vi.fn(() => () => undefined),
}));

const { useEntryStore } = await import("../../../stores/entryStore");
const { useSessionStore } = await import("../../../stores/sessionStore");
const { useArticleTabsStore } = await import("../../../stores/articleTabsStore");
const { invoke } = await import("../../../lib/electron");
const { default: KnowledgePanel } = await import("../KnowledgePanel");
const { default: VaultKnowledgeView } = await import("../VaultKnowledgeView");
const { default: ReviewChangesDialog } = await import("../ReviewChangesDialog");
const { lineDiff } = await import("../lineDiff");

const base = {
  folder_id: null, parent_entry_id: null, sort_order: 0, host: null, port: null, credential_id: null, username: null,
  domain: null, icon: null, color: null, tags: [] as string[], is_favorite: false, notes: null, credential_type: null,
  created_at: "2026-10-01T00:00:00.000Z", updated_at: new Date().toISOString(),
};
const T1 = "2026-10-05T00:00:00.000Z";
const T2 = "2026-10-06T00:00:00.000Z";
const kb = (scope: string, kind: string, extra: Record<string, unknown> = {}) => ({
  v: 1, scope, kind, summary: `${kind} summary`, pinned: false, status: "active", author: { kind: "user" }, ...extra,
});
const article = (id: string, name: string, config: Record<string, unknown>, place: Record<string, unknown>) =>
  ({ ...base, id, name, entry_type: "document", config, ...place });

const asset = { ...base, id: "a1", name: "web-01", entry_type: "ssh", folder_id: "f1", tags: ["linux"], config: {} };
const overview = article("k1", "Overview", { content: "# web-01\nNginx front end", kb: kb("asset", "overview", { pinned: true }) }, { parent_entry_id: "a1" });
const steps = article("k2", "Restart steps", {
  content: "reload nginx",
  kb: kb("asset", "procedure", { last_editor: { kind: "agent", name: "Claude Code", at: T2 } }),
  kb_history: [
    { at: T1, author: { kind: "user" }, content: "restart nginx" },
    { at: T2, author: { kind: "agent", name: "Claude Code" }, content: "reload nginx" },
  ],
}, { parent_entry_id: "a1" });
const network = article("k3", "Network", { content: "VLAN 20", kb: kb("folder", "facts") }, { folder_id: "f1" });
const playbook = article("k4", "Patching", { content: "apt upgrade", kb: kb("vault", "playbook") }, { tags: ["Linux"] });
const archived = article("k5", "Old", { content: "x", kb: kb("asset", "facts", { status: "archived" }) }, { parent_entry_id: "a1" });

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  act(() => {
    useEntryStore.setState({
      entries: [asset as never],
      hiddenEntries: [overview, steps, network, playbook, archived] as never[],
      folders: [{ id: "f1", name: "Client X", parent_id: null, sort_order: 0, icon: null, color: null, created_at: "", updated_at: "" }],
      loadAll: vi.fn(async () => undefined),
    });
    useSessionStore.setState({ sessions: [] } as never);
  });
});

describe("KnowledgePanel", () => {
  it("shows the pinned overview, own articles by kind, then what it inherits", () => {
    const { container } = render(<KnowledgePanel target={{ entryId: "a1" }} />);
    expect(screen.getByText("Nginx front end")).toBeInTheDocument();
    expect(screen.getByText("Procedures")).toBeInTheDocument();
    expect(screen.getByText("Restart steps")).toBeInTheDocument();
    expect(screen.getByLabelText("Not reviewed")).toBeInTheDocument();
    expect(screen.getByText("Also applies (2)")).toBeInTheDocument();
    const rows = [...container.querySelectorAll("[data-cv-kb-article]")].map((r) => r.getAttribute("data-cv-kb-article"));
    expect(rows).toEqual(["k2", "k3", "k4"]);
    expect(screen.queryByText("Old")).not.toBeInTheDocument();
  });

  it("opens an article as a sub-tab of the asset's Info tab, not a new pane tab", () => {
    render(<KnowledgePanel target={{ entryId: "a1" }} />);
    fireEvent.click(screen.getByText("Restart steps"));
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useArticleTabsStore.getState().byHost["dashboard::a1"]).toEqual({ open: ["k2"], active: "k2" });
  });
});

describe("VaultKnowledgeView", () => {
  it("lists every active article with a review queue, and filters", () => {
    render(<VaultKnowledgeView />);
    const queue = screen.getByText("Needs review (1)").closest("section")!;
    expect(within(queue).getByText("Restart steps")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Where"), { target: { value: "vault" } });
    expect(screen.getAllByText("Patching")).toHaveLength(1);
    expect(screen.queryByText("Network")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "archived" } });
    fireEvent.change(screen.getByLabelText("Where"), { target: { value: "all" } });
    expect(screen.getByText("Old")).toBeInTheDocument();
  });

  it("searches titles and bodies", () => {
    render(<VaultKnowledgeView />);
    fireEvent.change(screen.getByLabelText("Search knowledge"), { target: { value: "vlan" } });
    expect(screen.getByText("Network")).toBeInTheDocument();
    expect(screen.queryByText("Patching")).not.toBeInTheDocument();
  });

  const layoutGrid = () => screen.getByLabelText("Search knowledge").closest(".grid") as HTMLElement;

  it("puts the review queue in a second column after the list, so tab order matches the layout", () => {
    render(<VaultKnowledgeView />);
    const grid = layoutGrid();
    expect(grid.className).toContain("@5xl:grid-cols-[minmax(0,1fr)_minmax(18rem,26rem)]");
    const [main, queue] = [...grid.children] as HTMLElement[];
    expect(within(main).getByLabelText("Search knowledge")).toBeInTheDocument();
    expect(within(queue).getByText("Needs review (1)")).toBeInTheDocument();
    expect(queue.className).not.toMatch(/(^|[\s:])(col-start|row-start|order)-/);
  });

  it("uses one full-width column when there is nothing to review", () => {
    act(() => useEntryStore.setState({ hiddenEntries: [overview, network, playbook] as never[] }));
    render(<VaultKnowledgeView />);
    expect(screen.queryByText(/Needs review \(/)).not.toBeInTheDocument();
    const grid = layoutGrid();
    expect(grid.className).not.toMatch(/@5xl:grid-cols/);
    expect(grid.children).toHaveLength(1);
  });

  it("drops the second column while another state filter hides the queue", () => {
    render(<VaultKnowledgeView />);
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "review" } });
    expect(layoutGrid().className).not.toMatch(/@5xl:grid-cols/);
  });
});

describe("ReviewChangesDialog", () => {
  it("shows the agent's change against the baseline and undoes it", async () => {
    const onClose = vi.fn();
    render(<ReviewChangesDialog entry={steps as never} kb={steps.config.kb as never} onClose={onClose} />);
    expect(screen.getByText("restart nginx")).toBeInTheDocument();
    expect(screen.getByText("reload nginx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo changes" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("kb_undo", { id: "k2" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("offers Archive for an agent-created article nobody reviewed", () => {
    const history = steps.config.kb_history as unknown[];
    const agentMade = { ...steps, config: { ...steps.config, kb_history: [history[1]] } };
    render(<ReviewChangesDialog entry={agentMade as never} kb={steps.config.kb as never} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Archive article" })).toBeInTheDocument();
  });
});

describe("lineDiff", () => {
  it("marks added and removed lines", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
  });
});

describe("lineDiff of a new article", () => {
  it("has no removed line when there was no text before", () => {
    expect(lineDiff("", "a")).toEqual([{ kind: "added", text: "a" }]);
  });
});
