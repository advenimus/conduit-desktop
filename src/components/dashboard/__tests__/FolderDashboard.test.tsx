import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import FolderDashboard from "../FolderDashboard";
import { useEntryStore } from "../../../stores/entryStore";
import { entry, folder, minutesAgo, rowParts } from "./fixtures";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

const FOLDERS = [folder({ id: "f1", name: "Production" }), folder({ id: "f2", name: "Databases", parent_id: "f1" })];
const ENTRIES = [
  entry({ id: "a", name: "db-01", entry_type: "ssh", folder_id: "f2", created_at: minutesAgo(60 * 24 * 2), updated_at: minutesAgo(5) }),
  entry({ id: "b", name: "DC-01", entry_type: "rdp", folder_id: "f1", created_at: minutesAgo(60 * 24 * 40), updated_at: minutesAgo(90) }),
];

const setSelectedEntry = vi.fn();
const openEntry = vi.fn();

function setup(entries = ENTRIES) {
  useEntryStore.setState({ entries, folders: FOLDERS, setSelectedEntry, openEntry } as never);
  return render(<FolderDashboard folderId="f1" />);
}

const section = (title: string) => screen.getByRole("heading", { level: 3, name: title }).closest("section") as HTMLElement;

beforeEach(() => {
  setSelectedEntry.mockReset();
  openEntry.mockReset();
});

describe("FolderDashboard (restyle)", () => {
  it("sits on the editor surface and keeps the header texts", () => {
    const { container } = setup();
    expect(container.firstElementChild).toHaveClass("bg-editor");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Production");
    expect(screen.getByText("2 entries · 1 sub-folder")).toBeInTheDocument();
    expect(container.querySelector(".bg-canvas, .bg-panel")).toBeNull();
  });

  it("draws the type summary as cards and the distribution with entry-type tokens", () => {
    const { container } = setup();
    expect(screen.getByText("SSH").closest(".border-card-border")).not.toBeNull();
    expect(screen.getByText("Type Distribution")).toBeInTheDocument();
    expect(screen.getByTitle("SSH: 1")).toHaveClass("bg-entry-ssh");
    expect(screen.getByTitle("RDP: 1")).toHaveClass("bg-entry-rdp");
    expect(container.innerHTML).not.toMatch(/bg-(green|blue|purple|cyan|yellow|teal|amber)-400/);
  });

  it("keeps Recent Activity and Entry Age in order as clickable rows with visible times", () => {
    setup();
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(["Recent Activity", "Entry Age"]);

    const recent = within(section("Recent Activity")).getAllByRole("button");
    expect(recent.map((r) => r.querySelector(".truncate")?.textContent)).toEqual(["db-01", "DC-01"]);
    expect(recent[0]).toHaveTextContent("5m ago");
    fireEvent.click(recent[0]);
    expect(setSelectedEntry).toHaveBeenCalledWith("a");
    fireEvent.doubleClick(recent[0]);
    expect(openEntry).toHaveBeenCalledWith("a");

    const age = within(section("Entry Age")).getAllByRole("button");
    expect(age.map(rowParts)).toEqual([
      { label: "DC-01", meta: "1mo ago" },
      { label: "db-01", meta: "2d ago" },
    ]);
    fireEvent.click(age[0]);
    expect(setSelectedEntry).toHaveBeenCalledWith("b");
  });

  it("keeps the empty state and its New Entry primary button", () => {
    setup([]);
    expect(screen.getByText("This folder is empty")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "New Entry" });
    expect(button).toHaveClass("bg-btn-primary");
    const onNew = vi.fn();
    document.addEventListener("conduit:new-entry", onNew, { once: true });
    fireEvent.click(button);
    expect(onNew).toHaveBeenCalled();
  });
});
