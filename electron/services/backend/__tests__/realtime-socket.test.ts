// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeSocket, realtimeUrl, reconnectDelay } from '../realtime-socket.js';

class FakeSocket extends EventTarget {
  static all: FakeSocket[] = [];
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Record<string, unknown>[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  serverSays(msg: unknown) {
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(msg) }));
  }
  drop() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

const make = (onEvent = vi.fn(), onStatus = vi.fn()) =>
  new RealtimeSocket({
    endpoint: 'https://aw.example/v1', projectId: 'p1', sessionSecret: 'sek', channels: ['tablesdb.conduit.tables.vault_entries.rows'],
    queries: ['{"method":"equal"}'], onEvent, onStatus, WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
  });

afterEach(() => {
  FakeSocket.all = [];
  vi.useRealTimers();
});

describe('RealtimeSocket', () => {
  it('authenticates, subscribes, and passes on only its own events', async () => {
    const onEvent = vi.fn();
    const s = make(onEvent);
    const started = s.start();
    const ws = FakeSocket.all[0]!;
    expect(ws.url).toBe('wss://aw.example/v1/realtime?project=p1');
    ws.serverSays({ type: 'connected', data: { user: null } });
    await started;
    expect(ws.sent[0]).toEqual({ type: 'authentication', data: { session: 'sek' } });
    const sub = ws.sent[1] as { type: string; data: { subscriptionId: string; channels: string[]; queries: string[] }[] };
    expect(sub.type).toBe('subscribe');
    expect(sub.data[0]).toMatchObject({ channels: ['tablesdb.conduit.tables.vault_entries.rows'], queries: ['{"method":"equal"}'] });
    const id = sub.data[0]!.subscriptionId;
    ws.serverSays({ type: 'event', data: { events: ['x.update'], channels: [], payload: { a: 1 }, subscriptions: ['other'] } });
    ws.serverSays({ type: 'event', data: { events: ['x.update'], channels: [], payload: { a: 2 }, subscriptions: [id] } });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]![0].payload).toEqual({ a: 2 });
    await s.close();
  });

  it('a failed first connection rejects and does not retry on its own', async () => {
    vi.useFakeTimers();
    const s = make();
    const started = s.start();
    FakeSocket.all[0]!.drop();
    await expect(started).rejects.toThrow(/closed before/);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('reconnects after a later drop and stops after close()', async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const s = make(vi.fn(), onStatus);
    const started = s.start();
    FakeSocket.all[0]!.serverSays({ type: 'connected', data: { user: { $id: 'u' } } });
    await started;
    expect(FakeSocket.all[0]!.sent.map((m) => m.type)).toEqual(['subscribe']);
    FakeSocket.all[0]!.drop();
    expect(onStatus).toHaveBeenCalledWith('closed');
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    await s.close();
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('backs off like the SDK and builds ws urls', () => {
    expect([0, 5, 15, 100].map(reconnectDelay)).toEqual([1_000, 5_000, 10_000, 60_000]);
    expect(realtimeUrl('http://localhost:8085/v1', 'conduit-dev')).toBe('ws://localhost:8085/v1/realtime?project=conduit-dev');
  });
});
