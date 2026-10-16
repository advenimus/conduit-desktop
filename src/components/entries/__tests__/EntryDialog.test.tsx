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
const updateEntry = vi.fn(async (_id: string, _fields: Record<string, unknown>) => true);

function setup() {
  useVaultStore.setState({
    vaultType: "personal",
    currentVaultPath: "/v/Acme Infrastructure.conduit",
    teamVaultId: null,
    credentials: [],
    loadCredentials: vi.fn(async () => undefined),
  } as never);
  useEntryStore.setState({ entries: [], createEntry, getEntry, updateEntry } as never);
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
  updateEntry.mockClear();
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
    expect(buttonTexts(panel())).toEqual(["", "SSH", "RDP", "VNC", "Web", "RD Gateway", "Document", "Command", "Password", "SSH Key"]);
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
    expect(buttonTexts(nav)).toEqual(["General", "Credentials", "Information", "Display", "Resources", "Security", "Gateway"]);
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

describe("EntryDialog RDP gateway picker", () => {
  const nameField = () => labelWithText("Name*").querySelector("input")!;
  const nav = () => panel().querySelector("nav")!;
  const openGateway = () => fireEvent.click(within(nav()).getByRole("button", { name: "Gateway" }));
  const created = () => (createEntry.mock.calls as unknown as [Record<string, unknown>][]).map((c) => c[0]);

  beforeEach(() => {
    useEntryStore.setState({
      entries: [{ id: "g1", name: "East", entry_type: "credential", credential_type: "rd_gateway", config: { gatewayHostname: "east" } }],
    } as never);
  });

  it("saves the picked gateway's id", async () => {
    render(<EntryDialog onClose={vi.fn()} presetType="rdp" />);
    fireEvent.change(nameField(), { target: { value: "app-01" } });
    openGateway();
    fireEvent.change(screen.getByRole("combobox", { name: "Gateway" }), { target: { value: "g1" } });
    fireEvent.submit(panel().querySelector("form")!);
    await vi.waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect((created()[0].config as Record<string, unknown>).gatewayId).toBe("g1");
  });

  it("saves no gateway keys for an entry with no gateway", async () => {
    render(<EntryDialog onClose={vi.fn()} presetType="rdp" />);
    fireEvent.change(nameField(), { target: { value: "app-01" } });
    fireEvent.submit(panel().querySelector("form")!);
    await vi.waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect(Object.keys(created()[0].config as object).filter((k) => k.startsWith("gateway"))).toEqual([]);
  });

  it("creates a gateway from the picker and selects it", async () => {
    createEntry.mockResolvedValueOnce({ id: "g-new" } as never);
    render(<EntryDialog onClose={vi.fn()} presetType="rdp" />);
    openGateway();
    fireEvent.click(screen.getByRole("button", { name: "New gateway..." }));
    const dialogs = () => [...document.querySelectorAll("[data-dialog-content]")] as HTMLElement[];
    expect(dialogs()).toHaveLength(2);
    const nested = dialogs()[1];
    expect(within(nested).getByRole("heading", { level: 2 }).textContent).toBe("New RD Gateway Entry");
    fireEvent.change(within(nested).getByPlaceholderText("Office Gateway"), { target: { value: "New gw" } });
    fireEvent.click(within(nested.querySelector("nav")!).getByRole("button", { name: "Server" }));
    fireEvent.change(within(nested).getByLabelText("Gateway server"), { target: { value: "gw.new" } });
    fireEvent.submit(nested.querySelector("form")!);
    await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
    expect(created()[0]).toMatchObject({ entry_type: "credential", credential_type: "rd_gateway" });
    expect((screen.getByRole("combobox", { name: "Gateway" }) as HTMLSelectElement).value).toBe("g-new");
  });
});

describe("EntryDialog RD Gateway object", () => {
  const nav = () => panel().querySelector("nav")!;
  const tab = (name: string) => fireEvent.click(within(nav()).getByRole("button", { name }));
  const created = () => (createEntry.mock.calls as unknown as [Record<string, unknown>][]).map((c) => c[0]);

  function start() {
    render(<EntryDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "RD Gateway" }));
    fireEvent.change(labelWithText("Name*").querySelector("input")!, { target: { value: "Office gateway" } });
  }

  it("opens with the gateway tabs and title", () => {
    start();
    expect(heading().textContent).toBe("New RD Gateway Entry");
    expect(buttonTexts(nav())).toEqual(["General", "Information", "Server", "Login"]);
  });

  it("needs a server before it saves", () => {
    start();
    fireEvent.submit(panel().querySelector("form")!);
    expect(createEntry).not.toHaveBeenCalled();
    expect(panel().querySelector("[data-cv-dialog-footer] [data-cv-error]")?.textContent).toBe("Enter a gateway server.");
    expect(within(nav()).getByRole("button", { name: "Server" }).hasAttribute("data-selected")).toBe(true);
  });

  it("saves the address in config and a typed login in the login columns", async () => {
    start();
    tab("Server");
    const server = screen.getByLabelText("Gateway server");
    fireEvent.change(server, { target: { value: "gw.example.com:8443" } });
    fireEvent.blur(server);
    tab("Login");
    fireEvent.change(labelWithText("Username").querySelector("input")!, { target: { value: "CORP\\gwuser" } });
    fireEvent.change(labelWithText("Password").querySelector("input")!, { target: { value: "s3cret" } });
    fireEvent.submit(panel().querySelector("form")!);
    await vi.waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect(created()[0]).toMatchObject({
      entry_type: "credential",
      credential_type: "rd_gateway",
      credential_id: null,
      username: "CORP\\gwuser",
      password: "s3cret",
      config: { gatewayHostname: "gw.example.com", gatewayPort: 8443, gatewayLoginSource: "own" },
    });
    expect(Object.keys(created()[0].config as object).sort()).toEqual(["gatewayHostname", "gatewayLoginSource", "gatewayPort"]);
  });

  it("links a saved credential and never offers a gateway as the login", async () => {
    useVaultStore.setState({
      credentials: [
        { id: "c1", name: "Gateway Admin", username: "gwadmin", domain: null, tags: [], credential_type: null, created_at: "" },
        { id: "g9", name: "Other gateway", username: null, domain: null, tags: [], credential_type: "rd_gateway", created_at: "" },
      ],
    } as never);
    start();
    tab("Server");
    fireEvent.change(screen.getByLabelText("Gateway server"), { target: { value: "gw" } });
    tab("Login");
    fireEvent.click(screen.getByRole("radio", { name: "Use a saved credential" }));
    fireEvent.click(screen.getByRole("button", { name: "Saved credential" }));
    expect(screen.queryByText("Other gateway")).toBeNull();
    fireEvent.click(screen.getByText("Gateway Admin"));
    fireEvent.submit(panel().querySelector("form")!);
    await vi.waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect(created()[0]).toMatchObject({
      credential_id: null,
      username: null,
      password: null,
      domain: null,
      config: { gatewayHostname: "gw", gatewayLoginSource: "credential", gatewayCredentialId: "c1" },
    });
  });

  it("asks for a saved credential when that option has none picked", () => {
    start();
    tab("Server");
    fireEvent.change(screen.getByLabelText("Gateway server"), { target: { value: "gw" } });
    tab("Login");
    fireEvent.click(screen.getByRole("radio", { name: "Use a saved credential" }));
    fireEvent.submit(panel().querySelector("form")!);
    expect(createEntry).not.toHaveBeenCalled();
    expect(within(nav()).getByRole("button", { name: "Login" }).hasAttribute("data-selected")).toBe(true);
  });

  it("can use the RDP entry's login", async () => {
    start();
    tab("Server");
    fireEvent.change(screen.getByLabelText("Gateway server"), { target: { value: "gw" } });
    tab("Login");
    fireEvent.click(screen.getByRole("radio", { name: "Use the RDP entry's login" }));
    fireEvent.submit(panel().querySelector("form")!);
    await vi.waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect(created()[0]).toMatchObject({ credential_id: null, username: null, password: null, config: { gatewayLoginSource: "connection" } });
  });

  it("drops the gateway sub-type when the user goes Back and picks a connection", async () => {
    start();
    fireEvent.click(within(panel()).getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "RDP" }));
    fireEvent.change(labelWithText("Name*").querySelector("input")!, { target: { value: "app-01" } });
    fireEvent.submit(panel().querySelector("form")!);
    await vi.waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect(created()[0]).toMatchObject({ entry_type: "rdp", credential_type: undefined });
  });

  it("loads a saved gateway and says how many RDP entries use it", async () => {
    useEntryStore.setState({
      entries: [
        { id: "r1", name: "a", entry_type: "rdp", credential_type: null, config: { gatewayId: "g1" } },
        { id: "r2", name: "b", entry_type: "rdp", credential_type: null, config: { gatewayId: "g1" } },
      ],
    } as never);
    getEntry.mockResolvedValue({
      id: "g1", name: "Office gateway", entry_type: "credential", credential_type: "rd_gateway", credential_id: "c1",
      username: null, password: null, domain: null, private_key: null, totp_secret: null, icon: null, color: null,
      tags: [], notes: null, host: null, port: null, folder_id: null,
      config: { gatewayHostname: "gw.example.com", gatewayLoginSource: "own" },
    });
    render(<EntryDialog onClose={vi.fn()} editingEntryId="g1" />);
    await vi.waitFor(() => expect(heading().textContent).toBe("Edit RD Gateway Entry"));
    tab("Server");
    expect((screen.getByLabelText("Gateway server") as HTMLInputElement).value).toBe("gw.example.com");
    expect(screen.getByText("Used by 2 RDP entries.")).toBeTruthy();
    tab("Login");
    expect((screen.getByRole("radio", { name: "Use a saved credential" }) as HTMLInputElement).checked).toBe(true);
  });

  it("moves an older gateway's column link into the config when it is saved again", async () => {
    useVaultStore.setState({
      credentials: [{ id: "c1", name: "Gateway Admin", username: "gwadmin", domain: null, tags: [], credential_type: null, created_at: "" }],
    } as never);
    getEntry.mockResolvedValue({
      id: "g1", name: "Office gateway", entry_type: "credential", credential_type: "rd_gateway", credential_id: "c1",
      username: null, password: null, domain: null, private_key: null, totp_secret: null, icon: null, color: null,
      tags: [], notes: null, host: null, port: null, folder_id: null,
      config: { gatewayHostname: "gw.example.com", gatewayLoginSource: "own" },
    });
    render(<EntryDialog onClose={vi.fn()} editingEntryId="g1" />);
    await vi.waitFor(() => expect(heading().textContent).toBe("Edit RD Gateway Entry"));
    tab("Login");
    expect(screen.getByRole("button", { name: "Saved credential" }).textContent).toBe("Gateway Admin");
    fireEvent.submit(panel().querySelector("form")!);
    await vi.waitFor(() => expect(updateEntry).toHaveBeenCalledTimes(1));
    expect(updateEntry.mock.calls[0][1]).toMatchObject({
      credential_id: null,
      config: { gatewayLoginSource: "credential", gatewayCredentialId: "c1" },
    });
  });

  it("loads a gateway whose saved credential is linked in the config", async () => {
    useVaultStore.setState({
      credentials: [{ id: "c1", name: "Gateway Admin", username: "gwadmin", domain: null, tags: [], credential_type: null, created_at: "" }],
    } as never);
    getEntry.mockResolvedValue({
      id: "g1", name: "Office gateway", entry_type: "credential", credential_type: "rd_gateway", credential_id: null,
      username: null, password: null, domain: null, private_key: null, totp_secret: null, icon: null, color: null,
      tags: [], notes: null, host: null, port: null, folder_id: null,
      config: { gatewayHostname: "gw.example.com", gatewayLoginSource: "credential", gatewayCredentialId: "c1" },
    });
    render(<EntryDialog onClose={vi.fn()} editingEntryId="g1" />);
    await vi.waitFor(() => expect(heading().textContent).toBe("Edit RD Gateway Entry"));
    tab("Login");
    expect((screen.getByRole("radio", { name: "Use a saved credential" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Saved credential" }).textContent).toBe("Gateway Admin");
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
