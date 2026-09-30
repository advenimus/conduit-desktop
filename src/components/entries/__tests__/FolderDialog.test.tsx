import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import FolderDialog from "../FolderDialog";
import { useEntryStore } from "../../../stores/entryStore";
import { useTeamStore } from "../../../stores/teamStore";
import { useVaultStore } from "../../../stores/vaultStore";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

const createFolder = vi.fn(async () => ({ id: "f9" }));

const panel = () => document.querySelector("[data-dialog-content]") as HTMLElement;

beforeEach(() => {
  createFolder.mockClear();
  useVaultStore.setState({ vaultType: "personal", currentVaultPath: "/v/Acme.conduit", teamVaultId: null } as never);
  useEntryStore.setState({ folders: [], createFolder, updateFolder: vi.fn(async () => true) } as never);
  useTeamStore.setState({ teamVaults: [], getEffectiveRole: () => null } as never);
});

describe("FolderDialog", () => {
  it("is a Dialog at today's 384px width with the folder icon in the title and one form", () => {
    render(<FolderDialog onClose={vi.fn()} />);
    const h2 = within(panel()).getByRole("heading", { level: 2 });
    expect(h2.textContent).toBe("New Folder");
    expect(h2.querySelector("svg")).not.toBeNull();
    expect(panel().style.maxWidth).toBe("384px");
    const form = panel().querySelector("form[data-cv-dialog-form]") as HTMLFormElement;
    expect(form.contains(h2)).toBe(true);
    const footer = form.lastElementChild as HTMLElement;
    expect(footer.hasAttribute("data-cv-dialog-footer")).toBe(true);
    expect([...footer.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Create"]);
  });

  it("keeps the fields, placeholders and Appearance buttons", () => {
    render(<FolderDialog onClose={vi.fn()} />);
    const label = [...panel().querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === "Folder Name")!;
    const input = label.querySelector("input") as HTMLInputElement;
    expect(input.placeholder).toBe("My Servers");
    expect(document.activeElement).toBe(input);
    const appearance = [...panel().querySelectorAll("label")].find((l) => l.textContent === "Appearance")!;
    expect([...appearance.parentElement!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Default", "Default"]);
  });

  it("keeps today's close behavior: no Escape, no scrim click, the close button closes", () => {
    const onClose = vi.fn();
    render(<FolderDialog onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.mouseDown(panel().parentElement!);
    fireEvent.click(panel().parentElement!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(panel()).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("creates the folder on submit and closes", async () => {
    const onClose = vi.fn();
    render(<FolderDialog onClose={onClose} parentId="p1" />);
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("My Servers"), { target: { value: "Servers" } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createFolder).toHaveBeenCalledWith("Servers", "p1", null, null);
  });

  it("shows the view-only notice in a viewer's team folder and disables Create", () => {
    useVaultStore.setState({ vaultType: "team", teamVaultId: "t1" } as never);
    useTeamStore.setState({ teamVaults: [{ id: "t1", name: "Ops" }], getEffectiveRole: () => "viewer" } as never);
    render(<FolderDialog onClose={vi.fn()} parentId="p1" />);
    expect(panel().textContent).toContain("You have view-only access to this folder");
    expect(panel().textContent).toContain("Ops");
    fireEvent.change(screen.getByPlaceholderText("My Servers"), { target: { value: "Servers" } });
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
