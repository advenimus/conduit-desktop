import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore, type Session } from "../sessionStore";
import { HOME_SESSION_ID } from "../../lib/dashboardSessions";

// Stores read settings through window.electron while these modules load.
vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

const HOME: Session = { id: HOME_SESSION_ID, type: "dashboard", title: "Home", status: "connected" };
const SHELL: Session = { id: "s-shell", type: "local_shell", title: "Terminal", status: "connected" };

const ids = () => useSessionStore.getState().sessions.map((s) => s.id);

beforeEach(() => {
  useSessionStore.setState({ sessions: [HOME, SHELL], activeSessionId: HOME_SESSION_ID });
});

describe("sessionStore and the pinned Home tab", () => {
  it("does not close Home and sends no IPC for it", async () => {
    const invoke = vi.spyOn(window.electron, "invoke");
    await useSessionStore.getState().closeSession(HOME_SESSION_ID);
    expect(ids()).toEqual([HOME_SESSION_ID, "s-shell"]);
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockRestore();
  });

  it("does not remove Home and keeps it active", () => {
    useSessionStore.getState().removeSession(HOME_SESSION_ID);
    expect(ids()).toEqual([HOME_SESSION_ID, "s-shell"]);
    expect(useSessionStore.getState().activeSessionId).toBe(HOME_SESSION_ID);
  });

  it("does not give Home a new id", () => {
    useSessionStore.getState().replaceSessionId(HOME_SESSION_ID, "other", { title: "Other" });
    expect(useSessionStore.getState().sessions[0]).toEqual(HOME);
  });

  it("still closes and removes other tabs", async () => {
    await useSessionStore.getState().closeSession("s-shell");
    expect(ids()).toEqual([HOME_SESSION_ID]);
  });

  it("drops Home with everything else on clearAll", () => {
    useSessionStore.getState().clearAll();
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useSessionStore.getState().activeSessionId).toBeNull();
  });
});
