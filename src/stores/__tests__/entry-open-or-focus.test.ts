import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryMeta } from "../../types/entry";

const invoke = vi.fn();
vi.mock("../../lib/electron", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../../components/common/Toast", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("../../components/sessions/TerminalView", () => ({ disposeTerminalEntry: vi.fn() }));

const { useEntryStore } = await import("../entryStore");
const { useSessionStore } = await import("../sessionStore");
const { useLayoutStore, getAllLeaves } = await import("../layoutStore");
const { useTierStore } = await import("../tierStore");

const RDP = { id: "e1", name: "app-01", entry_type: "rdp", host: "app-01", port: 3389, config: {} } as unknown as EntryMeta;
const SSH = { id: "e2", name: "web-01", entry_type: "ssh", host: "web-01", port: 22, config: {} } as unknown as EntryMeta;

const activeTab = () => getAllLeaves(useLayoutStore.getState().root).find((l) => l.id === useLayoutStore.getState().focusedPaneId)?.activeSessionId;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "entry_resolve_credential") return { source: "inline", username: "u", password: "p", domain: null };
    if (cmd === "ssh_session_create") return "ssh-new";
    if (cmd === "rdp_connect") return { sessionId: "e1", width: 800, height: 600, mode: "gfx" };
    return null;
  });
  useSessionStore.setState({ sessions: [], activeSessionId: null });
  useTierStore.setState({ isEntryLocked: () => false } as never);
  useEntryStore.setState({ entries: [RDP, SSH] } as never);
});

function addTabs(...sessions: Parameters<ReturnType<typeof useSessionStore.getState>["addSession"]>[0][]) {
  for (const s of sessions) useSessionStore.getState().addSession(s);
}

describe("openOrFocusEntry", () => {
  it("switches to a connected RDP tab without connecting again", async () => {
    addTabs(
      { id: "e1", type: "rdp", title: "app-01", status: "connected", entryId: "e1" },
      { id: "t1", type: "local_shell", title: "Terminal", status: "connected" },
    );
    await useEntryStore.getState().openOrFocusEntry("e1");
    expect(invoke).not.toHaveBeenCalledWith("rdp_connect", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("rdp_disconnect", expect.anything());
    expect(activeTab()).toBe("e1");
  });

  it("switches to an open SSH tab instead of opening a second one", async () => {
    addTabs(
      { id: "ssh-old", type: "ssh", title: "web-01", status: "connected", entryId: "e2" },
      { id: "t1", type: "local_shell", title: "Terminal", status: "connected" },
    );
    await useEntryStore.getState().openOrFocusEntry("e2");
    expect(invoke).not.toHaveBeenCalledWith("ssh_session_create", expect.anything());
    expect(useSessionStore.getState().sessions.filter((s) => s.entryId === "e2")).toHaveLength(1);
    expect(activeTab()).toBe("ssh-old");
  });

  it("connects when the entry has no session, and its info tab does not count", async () => {
    addTabs({ id: "dashboard::e2", type: "dashboard", title: "web-01 (Info)", status: "connected", entryId: "e2" });
    await useEntryStore.getState().openOrFocusEntry("e2");
    expect(invoke).toHaveBeenCalledWith("ssh_session_create", expect.anything());
    expect(useSessionStore.getState().sessions.some((s) => s.id === "ssh-new")).toBe(true);
  });

  it("reconnects a dropped tab in place instead of adding another", async () => {
    vi.useFakeTimers();
    try {
      addTabs({ id: "ssh-old", type: "ssh", title: "web-01", status: "disconnected", error: "Connection lost", entryId: "e2" });
      const done = useEntryStore.getState().openOrFocusEntry("e2");
      await vi.runAllTimersAsync();
      await done;
    } finally {
      vi.useRealTimers();
    }
    const own = useSessionStore.getState().sessions.filter((s) => s.entryId === "e2");
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ id: "ssh-new", status: "connected" });
  });

  it("leaves a dropped tab alone when the plan locks the entry, instead of a stuck reconnect", async () => {
    useTierStore.setState({ isEntryLocked: (id: string) => id === "e2" } as never);
    addTabs({ id: "ssh-old", type: "ssh", title: "web-01", status: "disconnected", error: "Connection lost", entryId: "e2" });
    await useEntryStore.getState().openOrFocusEntry("e2");
    expect(invoke).not.toHaveBeenCalledWith("terminal_close", expect.anything());
    expect(useSessionStore.getState().sessions.find((s) => s.id === "ssh-old")).toMatchObject({ status: "disconnected" });
  });

  it("switches to a finished command tab without re-running it through a reconnect", async () => {
    useEntryStore.setState({ entries: [RDP, SSH, { id: "e3", name: "backup", entry_type: "command", config: {} } as unknown as EntryMeta] } as never);
    addTabs({ id: "e3", type: "command", title: "backup", status: "disconnected", entryId: "e3" });
    await useEntryStore.getState().openOrFocusEntry("e3");
    expect(invoke).not.toHaveBeenCalledWith("command_cancel", expect.anything());
    expect(useSessionStore.getState().sessions.find((s) => s.id === "e3")).toMatchObject({ status: "disconnected" });
    expect(activeTab()).toBe("e3");
  });
});
