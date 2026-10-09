import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/electron", () => ({
  invoke: vi.fn(async (cmd: string, args: { id?: string }) => {
    if (cmd === "entry_get_full") return { id: args.id, password: "hunter2-long", username: "root", totp_secret: null, config: {} };
    return null;
  }),
  listenSync: vi.fn(() => () => undefined),
}));

const { useEntryStore } = await import("../../../stores/entryStore");
const { default: MarkdownRenderer } = await import("../MarkdownRenderer");
const { invoke } = await import("../../../lib/electron");

const ID = "11111111-2222-4333-8444-555555555555";
const secret = {
  id: ID, name: "Local admin (renamed)", entry_type: "credential", folder_id: null, parent_entry_id: "a1", sort_order: 0,
  host: null, port: null, credential_id: null, username: null, domain: null, icon: null, color: null,
  config: { embedded: { owner_id: "a1", label: "Local admin" } }, tags: [], is_favorite: false, notes: null,
  credential_type: null, created_at: "x", updated_at: "x",
};

beforeEach(() => {
  act(() => useEntryStore.setState({ entries: [], hiddenEntries: [secret as never] }));
  vi.mocked(invoke).mockClear();
});

describe("secret chips", () => {
  it("shows the secret's current name, never the value, until revealed", async () => {
    render(<MarkdownRenderer content={`Admin pw: {{secret:${ID}|Local admin}}`} />);
    expect(screen.getByText("Local admin (renamed)")).toBeInTheDocument();
    expect(screen.queryByText("hunter2-long")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reveal Local admin (renamed)" }));
    await waitFor(() => expect(screen.getByText("hunter2-long")).toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("entry_get_full", { id: ID });
  });

  it("marks a ref whose secret is gone", () => {
    act(() => useEntryStore.setState({ hiddenEntries: [] }));
    render(<MarkdownRenderer content={`{{secret:${ID}|Old label}}`} />);
    expect(screen.getByText("Old label")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reveal/ })).not.toBeInTheDocument();
  });

  it("still renders legacy !!secret!! spans blurred", () => {
    const { container } = render(<MarkdownRenderer content="old: !!plain!!" />);
    expect(container.querySelector(".blur-sm")?.textContent).toBe("plain");
  });
});
