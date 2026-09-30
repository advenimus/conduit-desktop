import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import QuickBar from "../QuickBar";
import { openDashboardForEntry, openFolderView } from "../../../../lib/openDashboard";
import { entry, folder } from "../../__tests__/fixtures";
import { seedHomeStores } from "./homeTestStores";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});
vi.mock("../../../../lib/openDashboard", () => ({ openDashboardForEntry: vi.fn(), openFolderView: vi.fn() }));

const ENTRIES = [
  entry({ id: "s1", name: "web-01", entry_type: "ssh", host: "web01.example.com" }),
  entry({ id: "s2", name: "web-02", entry_type: "ssh" }),
  entry({ id: "c1", name: "Admin web", entry_type: "credential" }),
];
const FOLDERS = [folder({ id: "f1", name: "Webfarm" })];

function setup(opts: Parameters<typeof seedHomeStores>[0] = {}) {
  const actions = seedHomeStores({ entries: ENTRIES, folders: FOLDERS, ...opts });
  render(<QuickBar />);
  const input = screen.getByRole("combobox") as HTMLInputElement;
  const type = (value: string) => fireEvent.change(input, { target: { value } });
  const key = (k: string) => fireEvent.keyDown(input, { key: k });
  const options = () => screen.queryAllByRole("option");
  const activeName = () => options().find((o) => o.getAttribute("aria-selected") === "true")?.textContent;
  return { actions, input, type, key, options, activeName };
}

beforeEach(() => {
  vi.mocked(openDashboardForEntry).mockReset();
  vi.mocked(openFolderView).mockReset();
});

describe("QuickBar", () => {
  it("shows the search, Quick Connect with its Kbd and New Entry", () => {
    const { input } = setup();
    expect(input).toHaveAttribute("placeholder", "Search entries and folders...");
    const quick = screen.getByRole("button", { name: /Quick Connect/ });
    expect(quick).toHaveClass("bg-btn-primary");
    expect(quick.querySelector("kbd")).toHaveTextContent(/^(⌘N|Ctrl\+N)$/);
    const events: string[] = [];
    for (const name of ["conduit:quick-connect", "conduit:new-entry"]) document.addEventListener(name, () => events.push(name), { once: true });
    fireEvent.click(quick);
    fireEvent.click(screen.getByRole("button", { name: "New Entry" }));
    expect(events).toEqual(["conduit:quick-connect", "conduit:new-entry"]);
  });

  it("disables New Entry in a team vault the user cannot add to", () => {
    setup({ vaultType: "team", canCreate: false });
    const button = screen.getByRole("button", { name: "New Entry" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "View-only access");
  });

  it("shows results only while typing, with type labels and the combobox wiring", () => {
    const { input, type, options } = setup();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("web");
    expect(input).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(options().map((o) => o.textContent)).toEqual(["web-01SSH", "web-02SSH", "WebfarmFolder", "Admin webCredential"]);
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[0].id);
  });

  it("moves the active result with Down and Up, wrapping, and resets on a new query", () => {
    const { type, key, activeName, input, options } = setup();
    type("web");
    expect(activeName()).toBe("web-01SSH");
    key("ArrowDown");
    expect(activeName()).toBe("web-02SSH");
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[1].id);
    key("ArrowUp");
    key("ArrowUp");
    expect(activeName()).toBe("Admin webCredential");
    key("ArrowDown");
    expect(activeName()).toBe("web-01SSH");
    key("ArrowDown");
    type("web-");
    expect(activeName()).toBe("web-01SSH");
  });

  it("hover sets the active result", () => {
    const { type, options, activeName } = setup();
    type("web");
    fireEvent.mouseEnter(options()[3]);
    expect(activeName()).toBe("Admin webCredential");
  });

  it("Enter opens the active result by its type and clears the query", () => {
    const { actions, type, key, input } = setup();
    type("web");
    key("Enter");
    expect(actions.openEntry).toHaveBeenCalledWith("s1");
    expect(input.value).toBe("");
    type("web");
    key("ArrowUp");
    key("ArrowUp");
    key("Enter");
    expect(openFolderView).toHaveBeenCalledWith("f1");
  });

  it("a click opens: credentials show their info tab", () => {
    const { actions, type, options, input } = setup();
    type("admin");
    fireEvent.click(options()[0]);
    expect(openDashboardForEntry).toHaveBeenCalledWith("c1");
    expect(actions.openEntry).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("Escape clears the query, then blurs", () => {
    const { type, key, input } = setup();
    input.focus();
    type("web");
    key("Escape");
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    key("Escape");
    expect(document.activeElement).not.toBe(input);
  });

  it("says when nothing matches", () => {
    const { type } = setup();
    type("zzz");
    expect(screen.getByText("No entries or folders match")).toHaveClass("text-label", "text-ink-faint");
  });
});
