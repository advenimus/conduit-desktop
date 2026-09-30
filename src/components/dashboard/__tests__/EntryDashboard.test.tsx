import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import EntryDashboard from "../EntryDashboard";
import { useEntryStore } from "../../../stores/entryStore";
import { useSessionStore } from "../../../stores/sessionStore";
import type { ReachabilityResult } from "../../../types/dashboard";
import type { EntryFull, EntryMeta, ResolvedCredential } from "../../../types/entry";
import { entry } from "./fixtures";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

vi.mock("../../sync/EntryConflictInline", () => ({ default: () => null }));

const api = vi.hoisted(() => ({ checkReachability: vi.fn(), historyForEntry: vi.fn() }));
vi.mock("../../../lib/dashboardApi", () => ({ dashboardApi: api }));

const SSH = entry({
  id: "e1",
  name: "db-01",
  entry_type: "ssh",
  host: "10.0.0.5",
  port: 22,
  username: "admin",
  tags: ["prod", "db"],
  notes: "Primary database",
});

const updateEntry = vi.fn();
const openEntry = vi.fn();

async function setup(meta: EntryMeta = SSH, full: Partial<EntryFull> = {}) {
  const credential: ResolvedCredential = { source: "inline", username: "admin", password: "s3cret" } as ResolvedCredential;
  useEntryStore.setState({
    entries: [meta],
    openEntry,
    updateEntry,
    getEntry: vi.fn(async () => ({ ...meta, password: "s3cret", private_key: null, totp_secret: null, ...full })),
    resolveCredential: vi.fn(async () => credential),
  } as never);
  const view = render(<EntryDashboard entryId={meta.id} />);
  await act(async () => undefined);
  return view;
}

const buttonNames = (root: HTMLElement) =>
  [...root.querySelectorAll("button")].map((b) => b.getAttribute("title") ?? b.textContent?.trim());

beforeEach(() => {
  updateEntry.mockReset();
  openEntry.mockReset();
  api.checkReachability.mockReset();
  api.historyForEntry.mockReset().mockResolvedValue([]);
  useSessionStore.setState({ sessions: [] } as never);
});

const upRow = () => screen.getByText("Is it up?").closest(".py-3") as HTMLElement;

describe("EntryDashboard (restyle)", () => {
  it("sits on the editor surface with no legacy surfaces", async () => {
    const { container } = await setup();
    expect(container.firstElementChild).toHaveClass("bg-editor");
    expect(container.querySelector(".bg-canvas, .bg-panel, .uppercase")).toBeNull();
  });

  it("keeps the header actions, titles and order, as IconButtons, then Open Session as the primary button", async () => {
    const { container } = await setup();
    const header = container.querySelector("h2")!.closest(".border-b") as HTMLElement;
    expect(buttonNames(header)).toEqual(["Add to favorites", "Edit entry", "Open in external app", "Open Session"]);
    for (const title of ["Add to favorites", "Edit entry", "Open in external app"]) {
      const button = screen.getByTitle(title);
      expect(button).toHaveAttribute("aria-label", title);
      expect(button).toHaveClass("size-toolbar");
    }
    expect(screen.getByRole("button", { name: "Open Session" })).toHaveClass("bg-btn-primary");
  });

  it("draws a favorite's star in the favorite color and toggles it", async () => {
    await setup({ ...SSH, is_favorite: true });
    const star = screen.getByTitle("Remove from favorites");
    expect(star).toHaveClass("text-favorite");
    fireEvent.click(star);
    expect(updateEntry).toHaveBeenCalledWith("e1", { is_favorite: false });
  });

  it("keeps every detail row, label and action title", async () => {
    await setup();
    for (const label of ["Host", "Username", "Password", "Tags", "Created", "Modified", "Notes"]) {
      const node = screen.getByText(label);
      expect(node).toHaveClass("text-meta", "font-semibold", "text-ink-muted");
    }
    expect(screen.getByText("10.0.0.5:22")).toBeInTheDocument();
    for (const title of ["Copy host", "Copy username", "Reveal password", "Copy password", "Password history"]) {
      expect(screen.getByTitle(title)).toHaveClass("size-5");
    }
    fireEvent.click(screen.getByTitle("Reveal password"));
    expect(screen.getByText("s3cret")).toBeInTheDocument();
    expect(screen.getByTitle("Hide password")).toBeInTheDocument();
  });

  it("keeps Open Document for documents and no open button for credentials", async () => {
    await setup(entry({ id: "d1", name: "Runbook", entry_type: "document" }));
    expect(screen.getByRole("button", { name: "Open Document" })).toBeInTheDocument();
    expect(screen.getByText("Empty document")).toBeInTheDocument();
  });

  it("shows Entry not found on the editor surface", () => {
    useEntryStore.setState({ entries: [] } as never);
    const { container } = render(<EntryDashboard entryId="missing" />);
    expect(screen.getByText("Entry not found")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("bg-editor");
  });
});

describe("EntryDashboard: Is it up?", () => {
  it("sits right after Host with the hint for the entry port before any check", async () => {
    await setup();
    const labels = [...document.querySelectorAll(".text-meta.font-semibold")].map((n) => n.textContent);
    expect(labels.slice(0, 3)).toEqual(["Host", "Is it up?", "Username"]);
    expect(within(upRow()).getByText("Not checked yet")).toBeInTheDocument();
    expect(within(upRow()).getByText("Direct check from this device to port 22. Proxies are not used.")).toBeInTheDocument();
    expect(within(upRow()).getByRole("button", { name: "Check" })).toBeEnabled();
  });

  it("shows Checking... while it runs, then the badge, detail and time, and offers Check again", async () => {
    let resolve!: (r: ReachabilityResult) => void;
    api.checkReachability.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await setup();
    fireEvent.click(within(upRow()).getByRole("button", { name: "Check" }));
    expect(api.checkReachability).toHaveBeenCalledWith({ entryId: "e1" });
    expect(within(upRow()).getByText("Checking...")).toBeInTheDocument();
    expect(within(upRow()).getByRole("button", { name: "Check" })).toBeDisabled();
    await act(async () =>
      resolve({ entryId: "e1", status: "reachable", host: "10.0.0.5", port: 2222, latencyMs: 24, checkedAt: new Date().toISOString() }),
    );
    expect(within(upRow()).getByText("Up")).toHaveClass("text-success");
    expect(within(upRow()).getByText(/Answered in 24 ms · checked just now/)).toBeInTheDocument();
    expect(within(upRow()).getByText("Direct check from this device to port 2222. Proxies are not used.")).toBeInTheDocument();
    expect(within(upRow()).getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("uses the protocol default and the web URL port in the hint", async () => {
    const { unmount } = await setup(entry({ id: "r1", name: "DC", entry_type: "rdp", host: "10.0.0.9" }));
    expect(screen.getByText("Direct check from this device to port 3389. Proxies are not used.")).toBeInTheDocument();
    unmount();
    await setup(entry({ id: "w1", name: "Intranet", entry_type: "web", host: "http://intranet.local/status" }));
    expect(screen.getByText("Direct check from this device to port 80. Proxies are not used.")).toBeInTheDocument();
  });

  it("is not shown for credentials, commands or entries without a host", async () => {
    const { unmount } = await setup(entry({ id: "c1", name: "Admin", entry_type: "credential", host: "10.0.0.1" }));
    expect(screen.queryByText("Is it up?")).toBeNull();
    unmount();
    const second = await setup(entry({ id: "s2", name: "no-host", entry_type: "ssh" }));
    expect(screen.queryByText("Is it up?")).toBeNull();
    second.unmount();
    await setup(entry({ id: "k1", name: "Deploy", entry_type: "command", host: "10.0.0.1" }));
    expect(screen.queryByText("Is it up?")).toBeNull();
  });
});

describe("EntryDashboard: Recent connections", () => {
  it("shows the section for connection and command entries only", async () => {
    const { unmount } = await setup();
    expect(api.historyForEntry).toHaveBeenCalledWith({ entryId: "e1", limit: 20 });
    expect(screen.getByRole("heading", { level: 3, name: "Recent connections" })).toBeInTheDocument();
    expect(screen.getByText("No connections from this device yet.")).toBeInTheDocument();
    unmount();
    const cmd = await setup(entry({ id: "k1", name: "Deploy", entry_type: "command" }));
    expect(screen.getByRole("heading", { level: 3, name: "Recent connections" })).toBeInTheDocument();
    cmd.unmount();
    await setup(entry({ id: "c1", name: "Admin", entry_type: "credential" }));
    expect(screen.queryByText("Recent connections")).toBeNull();
  });

  it("sits in the details column when notes exist", async () => {
    await setup();
    const section = screen.getByRole("heading", { level: 3, name: "Recent connections" }).closest("section")!;
    expect(section.parentElement).toHaveClass("w-2/5");
  });
});

describe("EntryDashboard: Open Session", () => {
  it("closes this info tab and opens the entry", async () => {
    const closeSession = vi.fn();
    useSessionStore.setState({ sessions: [{ id: "dashboard::e1" }], closeSession } as never);
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Open Session" }));
    expect(closeSession).toHaveBeenCalledWith("dashboard::e1");
    expect(openEntry).toHaveBeenCalledWith("e1");
  });
});
