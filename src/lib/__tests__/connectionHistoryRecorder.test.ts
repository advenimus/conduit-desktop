import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../stores/sessionStore";
import type { HistoryEndRequest, HistoryStartRequest } from "../../types/dashboard";

vi.mock("../dashboardApi", () => ({
  dashboardApi: { historyStart: vi.fn(), historyEnd: vi.fn() },
}));

const { createConnectionHistoryRecorder, installConnectionHistoryRecorder } = await import("../connectionHistoryRecorder");
const { dashboardApi } = await import("../dashboardApi");
const { useSessionStore } = await import("../../stores/sessionStore");

type State = { sessions: Session[] };

class FakeSource {
  state: State = { sessions: [] };
  private listeners: Array<(s: State, p: State) => void> = [];
  getState(): State {
    return this.state;
  }
  subscribe(fn: (s: State, p: State) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }
  set(sessions: Session[]): void {
    const prev = this.state;
    this.state = { sessions };
    for (const l of this.listeners) l(this.state, prev);
  }
}

function session(id: string, status: Session["status"], extra: Partial<Session> = {}): Session {
  return { id, type: "ssh", title: id, status, entryId: "e1", ...extra };
}

let starts: HistoryStartRequest[];
let ends: HistoryEndRequest[];
let nextId: number;
let api: { historyStart: ReturnType<typeof vi.fn>; historyEnd: ReturnType<typeof vi.fn> };

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  starts = [];
  ends = [];
  nextId = 0;
  api = {
    historyStart: vi.fn(async (req: HistoryStartRequest) => {
      starts.push(req);
      nextId += 1;
      return { id: `row-${nextId}` };
    }),
    historyEnd: vi.fn(async (req: HistoryEndRequest) => {
      ends.push(req);
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(): FakeSource {
  const source = new FakeSource();
  createConnectionHistoryRecorder(source, api as never);
  return source;
}

describe("connection history recorder", () => {
  it("rule 2 and 5: starts on connecting and ends failed when it never connected", async () => {
    const src = setup();
    src.set([session("e1", "connecting")]);
    src.set([session("e1", "disconnected", { error: "refused" })]);
    await flush();
    expect(starts).toEqual([{ entryId: "e1", protocol: "ssh" }]);
    expect(ends).toEqual([{ id: "row-1", outcome: "failed" }]);
  });

  it("rule 3 and 5: ends dropped with an error after connecting, closed without one", async () => {
    const src = setup();
    src.set([session("a", "connected", { entryId: "e1" }), session("b", "connecting", { entryId: "e2", type: "rdp" })]);
    src.set([session("a", "connected", { entryId: "e1" }), session("b", "connected", { entryId: "e2", type: "rdp" })]);
    src.set([session("a", "disconnected", { entryId: "e1", error: "reset" }), session("b", "disconnected", { entryId: "e2", type: "rdp" })]);
    await flush();
    expect(ends).toEqual([
      { id: "row-1", outcome: "dropped" },
      { id: "row-2", outcome: "closed" },
    ]);
  });

  it("rule 1: an id swap keeps one row", async () => {
    const src = setup();
    src.set([session("e1", "connecting", { type: "web" })]);
    src.set([session("real-7", "connected", { type: "web" })]);
    src.set([]);
    await flush();
    expect(starts).toHaveLength(1);
    expect(ends).toEqual([{ id: "row-1", outcome: "closed" }]);
  });

  it("rule 1 does not swap across entries or protocols", async () => {
    const src = setup();
    src.set([session("e1", "connecting")]);
    src.set([session("x", "connecting", { entryId: "e2" }), session("y", "connecting", { type: "vnc" })]);
    await flush();
    expect(ends).toEqual([{ id: "row-1", outcome: "closed" }]);
    expect(starts).toHaveLength(3);
  });

  it("rule 4: a reconnect ends the row as closed and starts a new one", async () => {
    const src = setup();
    src.set([session("real-1", "connected")]);
    src.set([session("real-1", "connecting", { metadata: { reconnecting: true } })]);
    src.set([session("e1", "connecting")]);
    src.set([session("real-2", "connected")]);
    src.set([session("real-2", "disconnected")]);
    await flush();
    expect(starts).toHaveLength(2);
    expect(ends).toEqual([
      { id: "row-1", outcome: "closed" },
      { id: "row-2", outcome: "closed" },
    ]);
  });

  it("rule 6: a removed session ends closed; a later reopen starts a new row", async () => {
    const src = setup();
    src.set([session("e1", "connected")]);
    src.set([]);
    src.set([session("e1", "connecting")]);
    await flush();
    expect(ends).toEqual([{ id: "row-1", outcome: "closed" }]);
    expect(starts).toHaveLength(2);
  });

  it("after a disconnect, reconnecting in place starts a new row", async () => {
    const src = setup();
    src.set([session("e1", "connected")]);
    src.set([session("e1", "disconnected", { error: "gone" })]);
    src.set([session("e1", "disconnected", { error: "gone" })]);
    src.set([session("e1", "connecting")]);
    await flush();
    expect(starts).toHaveLength(2);
    expect(ends).toEqual([{ id: "row-1", outcome: "dropped" }]);
  });

  it("ignores sessions without an entry id and non-recordable types", async () => {
    const src = setup();
    src.set([
      session("mcp", "connected", { entryId: undefined }),
      session("shell", "connected", { type: "local_shell" }),
      session("doc", "connected", { type: "document" }),
      session("__home__", "connected", { type: "dashboard", entryId: undefined }),
      session("cmd", "connecting", { type: "command", entryId: "e5" }),
    ]);
    await flush();
    expect(starts).toEqual([{ entryId: "e5", protocol: "command" }]);
  });

  it("skips the end when start answered null (no vault open)", async () => {
    api.historyStart.mockResolvedValueOnce(null);
    const src = setup();
    src.set([session("e1", "connecting")]);
    src.set([]);
    await flush();
    expect(api.historyEnd).not.toHaveBeenCalled();
  });

  it("waits for the start before ending", async () => {
    let resolveStart: (v: { id: string }) => void = () => {};
    api.historyStart.mockImplementationOnce(() => new Promise((r) => (resolveStart = r)));
    const src = setup();
    src.set([session("e1", "connecting")]);
    src.set([]);
    await flush();
    expect(api.historyEnd).not.toHaveBeenCalled();
    resolveStart({ id: "late-row" });
    await flush();
    expect(ends).toEqual([{ id: "late-row", outcome: "closed" }]);
  });

  it("logs IPC errors with console.warn and keeps going", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    api.historyStart.mockRejectedValueOnce(new Error("Invalid request"));
    api.historyEnd.mockRejectedValueOnce(new Error("boom"));
    const src = setup();
    src.set([session("a", "connecting")]);
    src.set([session("b", "connecting", { entryId: "e2" })]);
    src.set([]);
    await flush();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(api.historyEnd).toHaveBeenCalledTimes(1);
  });

  it("the unsubscribe stops recording", async () => {
    const source = new FakeSource();
    const stop = createConnectionHistoryRecorder(source, api as never);
    stop();
    source.set([session("e1", "connecting")]);
    await flush();
    expect(starts).toEqual([]);
  });
});

describe("installConnectionHistoryRecorder", () => {
  it("records through the real session store and dashboardApi", async () => {
    const start = vi.mocked(dashboardApi.historyStart).mockResolvedValue({ id: "store-row" });
    const end = vi.mocked(dashboardApi.historyEnd).mockResolvedValue(undefined);
    const stop = installConnectionHistoryRecorder();
    try {
      useSessionStore.setState({ sessions: [session("e1", "connecting")], activeSessionId: null });
      useSessionStore.getState().replaceSessionId("e1", "real-1", { status: "connected" });
      useSessionStore.getState().clearAll();
      await flush();
      expect(start).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledWith({ id: "store-row", outcome: "closed" });
    } finally {
      stop();
    }
  });
});
