import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import EntryDialog from "../EntryDialog";
import { useEntryStore } from "../../../stores/entryStore";
import { useTeamStore } from "../../../stores/teamStore";
import { useVaultStore } from "../../../stores/vaultStore";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

const createEntry = vi.fn(async () => ({ id: "new" }));
const getEntry = vi.fn();

function setup() {
  useVaultStore.setState({
    vaultType: "personal",
    currentVaultPath: "/v/Acme Infrastructure.conduit",
    teamVaultId: null,
    credentials: [],
    loadCredentials: vi.fn(async () => undefined),
  } as never);
  useEntryStore.setState({ entries: [], createEntry, getEntry, updateEntry: vi.fn(async () => true) } as never);
  useTeamStore.setState({ teamVaults: [], getEffectiveRole: () => null } as never);
}

const panel = () => document.querySelector("[data-dialog-content]") as HTMLElement;
const scrim = () => panel().parentElement as HTMLElement;
const heading = () => within(panel()).getByRole("heading", { level: 2 });
const buttonTexts = (root: Element) => [...root.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
const labelWithText = (text: string) =>
  [...panel().querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === text) as HTMLLabelElement;

beforeEach(() => {
  setup();
  createEntry.mockClear();
  getEntry.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("EntryDialog type step", () => {
  it("is a Dialog titled New Entry at today's 448px width with the vault strip and the type chips", () => {
    render(<EntryDialog onClose={vi.fn()} />);
    expect(heading().textContent).toBe("New Entry");
    expect(panel().style.maxWidth).toBe("448px");
    expect(panel().textContent).toContain("Saving to:");
    expect(panel().textContent).toContain("Acme Infrastructure.conduit");
    expect(buttonTexts(panel())).toEqual(["", "SSH", "RDP", "VNC", "Web", "Document", "Command", "Password", "SSH Key"]);
    expect(panel().querySelector("form")).toBeNull();
  });

  it("draws the group labels without CSS uppercase and the chips on neutral tiles in their entry colors", () => {
    render(<EntryDialog onClose={vi.fn()} />);
    const label = screen.getByText("Connections");
    expect(label.className).not.toMatch(/uppercase|tracking/);
    expect(label.className).toContain("text-meta");
    const ssh = screen.getByRole("button", { name: "SSH" });
    expect(ssh.className).toContain("bg-well");
    expect(ssh.className).toContain("border-card-border");
    expect(ssh.className).toContain("text-entry-ssh");
    expect(screen.getByRole("button", { name: "Web" }).className).toContain("text-entry-web");
    expect(screen.getByRole("button", { name: "SSH Key" }).className).toContain("text-entry-sshkey");
  });

  it("keeps today's close behavior: no Escape, no scrim click, the close button closes", () => {
    const onClose = vi.fn();
    render(<EntryDialog onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.mouseDown(scrim());
    fireEvent.click(scrim());
    expect(onClose).not.toHaveBeenCalled();
    expect(panel()).not.toBeNull();
    fireEvent.click(within(panel()).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("EntryDialog form step", () => {
  it("opens the form at 768px inside one form with the nav, the fields and the footer", () => {
    render(<EntryDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    expect(heading().textContent).toBe("New SSH Entry");
    expect(panel().style.maxWidth).toBe("768px");
    const form = panel().querySelector("form[data-cv-dialog-form]") as HTMLFormElement;
    expect(form).not.toBeNull();
    expect(form.contains(heading())).toBe(true);
    const footer = form.lastElementChild as HTMLElement;
    expect(footer.hasAttribute("data-cv-dialog-footer")).toBe(true);
    expect(buttonTexts(footer)).toEqual(["Back", "Cancel", "Create"]);
    expect(within(footer).getByRole("button", { name: "Create" }).getAttribute("type")).toBe("submit");
  });

  it("uses NavList for the tabs, with group labels in title case and the selected tab marked", () => {
    render(<EntryDialog onClose={vi.fn()} presetType="rdp" />);
    const nav = panel().querySelector("nav") as HTMLElement;
    expect(buttonTexts(nav)).toEqual(["General", "Credentials", "Information", "Display", "Resources", "Security"]);
    expect(within(nav).getByText("Common").className).not.toMatch(/uppercase/);
    expect(within(nav).getByText("Connection")).toBeTruthy();
    const general = within(nav).getByRole("button", { name: "General" });
    expect(general.hasAttribute("data-selected")).toBe(true);
    fireEvent.click(within(nav).getByRole("button", { name: "Display" }));
    expect(within(nav).getByRole("button", { name: "Display" }).getAttribute("aria-current")).toBe("page");
    expect(labelWithText("Resolution").querySelector("select")).not.toBeNull();
  });

  it("wraps each single field in its label, the first span holding the exact text", () => {
    render(<EntryDialog onClose={vi.fn()} presetType="rdp" />);
    const name = labelWithText("Name*");
    expect(name.querySelector("input")?.getAttribute("placeholder")).toBe("Production Server");
    expect(labelWithText("Host").querySelector("input")?.getAttribute("placeholder")).toBe("192.168.1.1");
    expect(labelWithText("Port").querySelector("input")?.getAttribute("type")).toBe("number");
    expect(labelWithText("Domain").querySelector("input")?.getAttribute("placeholder")).toBe("DOMAIN");
    const appearance = [...panel().querySelectorAll("label")].find((l) => l.textContent === "Appearance");
    expect(appearance).toBeTruthy();
    expect(buttonTexts(appearance!.parentElement!)).toEqual(["Default Icon", "Default Color"]);
  });

  it("keeps the Credentials tab's controls in today's order", () => {
    render(<EntryDialog onClose={vi.fn()} presetType="rdp" />);
    fireEvent.click(screen.getByRole("button", { name: "Credentials" }));
    const password = [...panel().querySelectorAll("label")].find((l) => l.textContent === "Password")!;
    const group = password.parentElement as HTMLElement;
    expect(group.querySelector("input")?.getAttribute("type")).toBe("password");
    expect([...group.querySelectorAll("button")].map((b) => b.getAttribute("title"))).toEqual(["Password Generator", "Show password"]);
    expect(screen.getByRole("button", { name: "Import QR Code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enter Secret Key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "None (use inline credentials)" })).toBeTruthy();
  });

  it("shows the SSH username error as data-cv-error and switches to the Credentials tab", () => {
    render(<EntryDialog onClose={vi.fn()} presetType="ssh" />);
    fireEvent.change(labelWithText("Name*").querySelector("input")!, { target: { value: "db-01" } });
    fireEvent.submit(panel().querySelector("form")!);
    const error = panel().querySelector("[data-cv-error]");
    expect(error?.textContent).toBe("Username is required for SSH connections");
    expect(screen.getByRole("button", { name: "Credentials" }).hasAttribute("data-selected")).toBe(true);
    expect(createEntry).not.toHaveBeenCalled();
  });

  it("keeps the close behavior in the form step", () => {
    const onClose = vi.fn();
    render(<EntryDialog onClose={onClose} presetType="ssh" />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(panel()).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("EntryDialog while loading an entry", () => {
  it("has no close button and ignores Escape", () => {
    getEntry.mockReturnValue(new Promise(() => undefined));
    const onClose = vi.fn();
    render(<EntryDialog onClose={onClose} editingEntryId="e1" />);
    expect(panel().textContent).toContain("Loading entry...");
    expect(within(panel()).queryByRole("button")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
