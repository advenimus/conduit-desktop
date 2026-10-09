import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/electron", () => ({
  invoke: vi.fn(async () => 2),
  listenSync: vi.fn(() => () => undefined),
}));

const { useEntryStore } = await import("../../../stores/entryStore");
const { default: NotesSecurityBanners } = await import("../NotesSecurityBanners");
const { invoke } = await import("../../../lib/electron");

const base = {
  id: "a1", name: "web-01", entry_type: "ssh", folder_id: null, parent_entry_id: null, sort_order: 0, host: "h", port: null,
  credential_id: null, username: null, domain: null, icon: null, color: null, config: {}, tags: [], is_favorite: false,
  credential_type: null, created_at: "x", updated_at: "x",
};

describe("NotesSecurityBanners", () => {
  it("offers to encrypt plaintext secrets", async () => {
    act(() => useEntryStore.setState({ hiddenEntries: [], loadAll: vi.fn(async () => undefined) }));
    render(<NotesSecurityBanners entry={{ ...base, notes: "a: !!x!! b: !!y!!" } as never} />);
    expect(screen.getByText("2 secrets in these notes are stored unencrypted.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Encrypt now" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("secret_encrypt_entry", { id: "a1" }));
  });

  it("counts unused secrets and asks before deleting them", async () => {
    const orphan = { ...base, id: "s1", entry_type: "credential", parent_entry_id: "a1", config: { embedded: { owner_id: "a1", label: "x", orphaned_at: "2026-01-01T00:00:00.000Z" } } };
    act(() => useEntryStore.setState({ hiddenEntries: [orphan as never], loadAll: vi.fn(async () => undefined) }));
    render(<NotesSecurityBanners entry={{ ...base, notes: "" } as never} />);
    expect(screen.getByText("1 encrypted secret is no longer used in any notes.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clean up" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("secret_cleanup_orphans", { owner_id: "a1" }));
  });
});
