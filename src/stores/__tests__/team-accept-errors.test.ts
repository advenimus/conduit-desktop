import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const toastError = vi.fn();
vi.mock("../../lib/electron", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../../components/common/Toast", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), info: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const { useTeamStore } = await import("../teamStore");

beforeEach(() => {
  invoke.mockReset();
  toastError.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("team invite accept errors (S18)", () => {
  it("shows the server's error text under the title", async () => {
    invoke.mockRejectedValue(new Error("All seats on this team are in use. Ask your team admin to add a seat."));
    await useTeamStore.getState().acceptInvitation("inv-1");
    expect(toastError).toHaveBeenCalledWith("Could not join the team", "All seats on this team are in use. Ask your team admin to add a seat.");
  });

  it("does not repeat the title when there is no server text (network failure, timeout, 5xx)", async () => {
    invoke.mockRejectedValue(new Error("Could not join the team."));
    await useTeamStore.getState().acceptInvitation("inv-1");
    expect(toastError).toHaveBeenCalledWith("Could not join the team", "Check your connection and try again.");
  });
});
