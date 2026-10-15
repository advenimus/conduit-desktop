import crypto from 'node:crypto';

// Own Realtime client: the web SDK's needs a global `window`, which fools main-process code into thinking it runs in a browser.

export interface RealtimeEvent {
  events: string[];
  channels: string[];
  payload: Record<string, unknown>;
}

export interface SocketOptions {
  endpoint: string;
  projectId: string;
  sessionSecret: string;
  channels: readonly string[];
  queries: readonly string[];
  onEvent: (e: RealtimeEvent) => void;
  onStatus?: (status: 'open' | 'closed' | 'error') => void;
  /** For tests. */
  WebSocketImpl?: typeof WebSocket;
}

const HEARTBEAT_MS = 20_000;

export function reconnectDelay(attempt: number): number {
  if (attempt < 5) return 1_000;
  if (attempt < 15) return 5_000;
  if (attempt < 100) return 10_000;
  return 60_000;
}

export function realtimeUrl(endpoint: string, projectId: string): string {
  return `${endpoint.replace(/^http/, 'ws')}/realtime?project=${encodeURIComponent(projectId)}`;
}

export class RealtimeSocket {
  private readonly opts: SocketOptions;
  private readonly subscriptionId = crypto.randomUUID();
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private closed = false;
  private firstOpen: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(opts: SocketOptions) {
    this.opts = opts;
  }

  /** Resolves once the subscription is sent; rejects if the first connection fails. Later drops reconnect on their own. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.firstOpen = { resolve, reject };
      this.connect();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.closed) return;
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const socket = new Impl(realtimeUrl(this.opts.endpoint, this.opts.projectId));
    this.socket = socket;
    socket.addEventListener('message', (m) => this.onMessage(socket, m.data));
    socket.addEventListener('error', () => this.opts.onStatus?.('error'));
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.stopHeartbeat();
      this.opts.onStatus?.('closed');
      if (this.closed) return;
      if (this.firstOpen) {
        // The caller owns retries until the first connection works.
        this.closed = true;
        this.firstOpen.reject(new Error('realtime connection closed before it was ready'));
        this.firstOpen = null;
        return;
      }
      this.retry = setTimeout(() => this.connect(), reconnectDelay(this.attempts++));
    });
  }

  private onMessage(socket: WebSocket, raw: unknown): void {
    let msg: { type?: string; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'connected') {
      if (!msg.data?.user) socket.send(JSON.stringify({ type: 'authentication', data: { session: this.opts.sessionSecret } }));
      socket.send(JSON.stringify({
        type: 'subscribe',
        data: [{ subscriptionId: this.subscriptionId, channels: [...this.opts.channels], queries: [...this.opts.queries] }],
      }));
      this.attempts = 0;
      this.startHeartbeat(socket);
      this.opts.onStatus?.('open');
      this.firstOpen?.resolve();
      this.firstOpen = null;
    } else if (msg.type === 'error') {
      console.warn('[realtime] server error:', (msg.data?.message as string | undefined) ?? 'unknown');
      this.opts.onStatus?.('error');
    } else if (msg.type === 'event') {
      const d = msg.data as { events?: string[]; channels?: string[]; payload?: Record<string, unknown>; subscriptions?: string[] } | undefined;
      if (!d?.events || !d.payload || !d.subscriptions?.includes(this.subscriptionId)) return;
      this.opts.onEvent({ events: d.events, channels: d.channels ?? [], payload: d.payload });
    }
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
