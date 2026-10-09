import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("../../../lib/electron", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "approval_list_pending" ? [] : true)),
  listenSync: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }),
}));

const { invoke } = await import("../../../lib/electron");
const { default: RevealApprovalDialog, REVEAL_REQUEST_EVENT, REVEAL_RESOLVED_EVENT } = await import("../RevealApprovalDialog");

const REQUEST = {
  request_id: "r1",
  agent_name: "Claude Code",
  kind: "secret",
  target_id: "s1",
  target_name: "Local admin",
  owner_name: "web-01",
  purpose: "Read it to the user over the phone",
};

beforeEach(() => {
  listeners.clear();
  vi.mocked(invoke).mockClear();
});

describe("RevealApprovalDialog", () => {
  it("shows who asks for what and why, and sends Allow", async () => {
    render(<RevealApprovalDialog />);
    act(() => listeners.get(REVEAL_REQUEST_EVENT)!({ payload: REQUEST }));
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Local admin on web-01")).toBeInTheDocument();
    expect(screen.getByText(REQUEST.purpose)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("approval_respond", { request_id: "r1", approved: true }));
    await waitFor(() => expect(screen.queryByText("Local admin on web-01")).not.toBeInTheDocument());
  });

  it("sends Deny", async () => {
    render(<RevealApprovalDialog />);
    act(() => listeners.get(REVEAL_REQUEST_EVENT)!({ payload: REQUEST }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("approval_respond", { request_id: "r1", approved: false }));
  });

  it("closes when the main process times the request out", () => {
    render(<RevealApprovalDialog />);
    act(() => listeners.get(REVEAL_REQUEST_EVENT)!({ payload: REQUEST }));
    act(() => listeners.get(REVEAL_RESOLVED_EVENT)!({ payload: { request_id: "r1" } }));
    expect(screen.queryByText("Local admin on web-01")).not.toBeInTheDocument();
  });
});
