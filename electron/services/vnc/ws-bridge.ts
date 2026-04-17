/**
 * WebSocket-to-TCP bridge for VNC connections.
 *
 * Creates a per-session WebSocket server on localhost that pipes binary
 * data bidirectionally between a WebSocket client (noVNC in the renderer)
 * and a raw TCP socket to the VNC server.
 *
 * The bridge is resilient to WebSocket client reconnections (e.g., React
 * StrictMode double-mount). Each new WS client gets a fresh TCP connection
 * to the VNC server. The bridge is only destroyed via explicit close().
 */

import net from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { resolveHostname } from '../dns-resolver.js';

export interface WsBridge {
  wsUrl: string;
  close(): void;
}

export class VncWsBridgeManager {
  private _bridges: Map<string, WsBridge> = new Map();

  /**
   * Create a WS-TCP bridge for a VNC session.
   *
   * Starts a WebSocket server on a random localhost port. Each time a
   * WebSocket client connects, the bridge opens a fresh TCP connection
   * to the VNC server and pipes data bidirectionally.
   *
   * @returns The WebSocket URL for the renderer to connect noVNC to.
   */
  async create(sessionId: string, host: string, port: number): Promise<WsBridge> {
    if (this._bridges.has(sessionId)) {
      throw new Error(`WS bridge already exists for session: ${sessionId}`);
    }

    return new Promise<WsBridge>((resolve, reject) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: 0, // OS-assigned
        perMessageDeflate: false, // VNC data is already compressed (ZRLE/Tight use zlib internally)
      });

      let destroyed = false;

      const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        // Close all connected clients
        for (const client of wss.clients) {
          try { client.close(); } catch { /* ignore */ }
        }
        try { wss.close(); } catch { /* ignore */ }
        this._bridges.delete(sessionId);
        console.log(`[VNC WS Bridge ${sessionId}] Bridge destroyed`);
      };

      wss.on('error', (err) => {
        console.error(`[VNC WS Bridge ${sessionId}] Server error:`, err.message);
        destroy();
        reject(err);
      });

      wss.on('listening', () => {
        const addr = wss.address();
        if (!addr || typeof addr === 'string') {
          destroy();
          reject(new Error('Failed to get WS server address'));
          return;
        }

        const wsUrl = `ws://127.0.0.1:${addr.port}`;

        const bridge: WsBridge = {
          wsUrl,
          close: destroy,
        };
        this._bridges.set(sessionId, bridge);

        // Accept WebSocket connections — each gets a fresh TCP pipe
        wss.on('connection', async (ws) => {
          if (destroyed) {
            ws.close(4001, 'Bridge destroyed');
            return;
          }

          console.log(`[VNC WS Bridge ${sessionId}] WS client connected`);

          let tcpSocket: net.Socket | null = null;

          // Tear down this specific WS↔TCP pair (not the whole bridge)
          const cleanupPair = () => {
            try { ws.close(); } catch { /* ignore */ }
            try { tcpSocket?.destroy(); } catch { /* ignore */ }
            tcpSocket = null;
          };

          // Pre-resolve hostname (dns.lookup can fail on corporate Windows machines)
          const resolvedHost = await resolveHostname(host);

          // Open TCP connection to VNC server
          tcpSocket = net.createConnection({ host: resolvedHost, port }, () => {
            console.log(`[VNC WS Bridge ${sessionId}] TCP connected to ${resolvedHost}:${port}`);
          });
          tcpSocket.setNoDelay(true); // Disable Nagle's — reduces mouse/keyboard input latency

          tcpSocket.on('data', (data) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(data);
            }
          });

          tcpSocket.on('close', () => {
            console.log(`[VNC WS Bridge ${sessionId}] TCP closed`);
            cleanupPair();
          });

          tcpSocket.on('error', (err) => {
            console.error(`[VNC WS Bridge ${sessionId}] TCP error:`, err.message);
            cleanupPair();
          });

          ws.on('message', (data) => {
            if (tcpSocket && !tcpSocket.destroyed) {
              const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
              tcpSocket.write(buf);
            }
          });

          ws.on('close', () => {
            console.log(`[VNC WS Bridge ${sessionId}] WS client closed`);
            cleanupPair();
          });

          ws.on('error', (err) => {
            console.error(`[VNC WS Bridge ${sessionId}] WS error:`, err.message);
            cleanupPair();
          });
        });

        resolve(bridge);
      });
    });
  }

  /**
   * Destroy a specific bridge.
   */
  destroy(sessionId: string): void {
    const bridge = this._bridges.get(sessionId);
    if (bridge) {
      bridge.close();
    }
  }

  /**
   * Destroy all bridges (for app shutdown).
   */
  destroyAll(): void {
    for (const [, bridge] of this._bridges) {
      bridge.close();
    }
    this._bridges.clear();
  }
}
