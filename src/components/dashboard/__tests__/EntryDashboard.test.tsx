import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import EntryDashboard from "../EntryDashboard";
import { useEntryStore } from "../../../stores/entryStore";
import type { EntryFull, EntryMeta, ResolvedCredential } from "../../../types/entry";
import { entry } from "./fixtures";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

vi.mock("../../sync/EntryConflictInline", () => ({ default: () => null }));

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

async function setup(meta: EntryMeta = SSH, full: Partial<EntryFull> = {}) {
  const credential: ResolvedCredential = { source: "inline", username: "admin", password: "s3cret" } as ResolvedCredential;
  useEntryStore.setState({
    entries: [meta],
    openEntry: vi.fn(),
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

beforeEach(() => updateEntry.mockReset());

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
