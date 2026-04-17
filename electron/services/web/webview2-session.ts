/**
 * WebView2 session — manages a single conduit-webview2 helper process.
 *
 * Communicates via a Windows named pipe using newline-delimited JSON protocol.
 * The helper binary renders web content using Edge WebView2 on Windows,
 * providing native rendering instead of Electron's built-in Chromium.
 *
 * Protocol (newline-delimited JSON over named pipe):
 *   Client → Helper:  { type: "navigate", url: "..." }
 *   Helper → Client:  { type: "ready" }
 *                     { type: "navigation_completed", url: "...", is_success: true }
 *                     { type: "title_changed", title: "..." }
 *                     { type: "new_window", url: "..." }
 *                     { type: "script_result", id: "...", result: ... }
 *                     { type: "screenshot", id: "...", data: "base64..." }
 *                     { type: "error", message: "..." }
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { getWebView2BinaryPath } from './engines/factory.js';

/** Bounds rectangle for the WebView2 control within the host window */
export interface WebView2Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pending request awaiting a response from the helper process */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Timeout for the initial ready message after spawning the helper (ms) */
const READY_TIMEOUT_MS = 10_000;

/** Timeout for individual script execution / screenshot requests (ms) */
const REQUEST_TIMEOUT_MS = 15_000;

export class WebView2Session extends EventEmitter {
  readonly sessionId: string;

  /** Current URL (tracked via navigation events from the helper) */
  currentUrl = '';
  /** Current page title (tracked via title events from the helper) */
  currentTitle: string | null = null;
  /** Last-known viewport dimensions for dimension queries */
  lastBounds: { width: number; height: number } = { width: 800, height: 600 };
  /** Relative DIP bounds (content-area-relative) — used by manager to recompute screen coords on window move */
  relativeBounds: WebView2Bounds = { x: 0, y: 0, width: 800, height: 600 };

  private process: ChildProcess | null = null;
  private pipe: Socket | null = null;
  private pipeName: string;
  private readBuffer = '';
  private pendingRequests = new Map<string, PendingRequest>();
  private _closed = false;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
    this.pipeName = `\\\\.\\pipe\\conduit-wv2-${sessionId}`;
  }

  /** Whether the session has been closed or the process has exited */
  get closed(): boolean {
    return this._closed;
  }

  /**
   * Spawn the WebView2 helper process, connect to its named pipe,
   * and wait for the ready message.
   */
  async create(
    hwnd: Buffer,
    url: string,
    relativeBounds?: WebView2Bounds,
    screenBounds?: WebView2Bounds,
  ): Promise<void> {
    if (this._closed) {
      throw new Error('Session has been closed');
    }

    const binaryPath = getWebView2BinaryPath();
    // getNativeWindowHandle() returns a Buffer containing the HWND as a native pointer.
    // Read it as a 64-bit little-endian integer (works on both 32-bit and 64-bit).
    const hwndValue = hwnd.length >= 8 ? hwnd.readBigInt64LE(0) : BigInt(hwnd.readUInt32LE(0));

    console.log(`[WebView2] Spawning helper: ${binaryPath}`);
    console.log(`[WebView2] Session ${this.sessionId.slice(0, 8)}: hwnd=${hwndValue}, pipe=${this.pipeName}, url=${url}`);

    this.process = spawn(binaryPath, [
      `--hwnd=${hwndValue}`,
      `--pipe=${this.pipeName}`,
      `--url=${url}`,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Forward stderr for diagnostics
    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        for (const line of msg.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) {
            console.log(`[WebView2] ${trimmed}`);
          }
        }
      }
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      console.log(`[WebView2] Process exited: code=${code}, signal=${signal}`);
      this.cleanup(`Process exited with code ${code}`);
    });

    this.process.on('error', (err) => {
      console.error(`[WebView2] Process error:`, err);
      this.cleanup(err.message);
    });

    // Wait for the helper to create the named pipe, then connect
    await this.connectToPipe();

    // Wait for the ready message
    await this.waitForReady();

    // Set initial bounds if provided (omit for additional tabs — frontend
    // will send updateBounds after the tab bar renders with correct offsets)
    if (relativeBounds && screenBounds) {
      this.setBounds(relativeBounds, screenBounds);
    }
    this.currentUrl = url;

    console.log(`[WebView2] Session ${this.sessionId.slice(0, 8)} ready`);
  }

  /** Navigate to a new URL */
  navigate(url: string): void {
    this.sendMessage({ type: 'navigate', url });
  }

  /** Store relative bounds and send screen-absolute coordinates to the helper.
   *  @param relativeBounds Bounds relative to the Electron content area (DIP)
   *  @param screenBounds Absolute screen coordinates to send to the helper (DIP)
   */
  setBounds(relativeBounds: WebView2Bounds, screenBounds: WebView2Bounds): void {
    this.relativeBounds = { ...relativeBounds };
    this.lastBounds = { width: relativeBounds.width, height: relativeBounds.height };
    this.sendMessage({
      type: 'set_bounds',
      x: screenBounds.x,
      y: screenBounds.y,
      width: screenBounds.width,
      height: screenBounds.height,
    });
  }

  /** Show the WebView2 control */
  show(): void {
    this.sendMessage({ type: 'show' });
  }

  /** Hide the WebView2 control */
  hide(): void {
    this.sendMessage({ type: 'hide' });
  }

  /** Navigate back in history */
  goBack(): void {
    this.sendMessage({ type: 'go_back' });
  }

  /** Navigate forward in history */
  goForward(): void {
    this.sendMessage({ type: 'go_forward' });
  }

  /** Execute JavaScript in the WebView2 page context and return the result.
   *  @param timeoutMs Override the default timeout (e.g. for long-running user interactions) */
  async executeScript(code: string, timeoutMs?: number): Promise<unknown> {
    const id = randomUUID();
    const timeout = timeoutMs ?? REQUEST_TIMEOUT_MS;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Script execution timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.sendMessage({ type: 'execute_script', id, code });
    });
  }

  /** Capture a screenshot of the WebView2 content. Returns base64-encoded image data. */
  async captureScreenshot(): Promise<string> {
    const id = randomUUID();

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Screenshot capture timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as string),
        reject,
        timer,
      });
      this.sendMessage({ type: 'capture_screenshot', id });
    });
  }

  /** Send a download response to the helper process. */
  respondToDownload(downloadId: string, action: string, filePath?: string): void {
    this.sendMessage({
      type: 'download_response',
      id: downloadId,
      data: action,
      url: filePath ?? '',
    });
  }

  /** Close the session: send close message, disconnect pipe, kill process */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    // Send close command if pipe is still connected
    this.sendMessage({ type: 'close' });

    // Give the helper a moment to shut down gracefully
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          console.log(`[WebView2] Force-killing process for session ${this.sessionId.slice(0, 8)}`);
          this.process.kill();
        }
        resolve();
      }, 3000);

      if (this.process) {
        this.process.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });

    this.cleanup(null);
  }

  // ──────────────────────────────────────────────────────────────
  //  Private helpers
  // ──────────────────────────────────────────────────────────────

  /** Connect to the helper's named pipe with retry (the helper may need time to create it) */
  private connectToPipe(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const startTime = Date.now();
      const maxWaitMs = 5000;
      const retryIntervalMs = 100;

      const attempt = () => {
        if (this._closed) {
          reject(new Error('Session closed before pipe connection'));
          return;
        }

        if (Date.now() - startTime > maxWaitMs) {
          reject(new Error(`Timed out waiting for named pipe: ${this.pipeName}`));
          return;
        }

        const socket = connect({ path: this.pipeName });

        socket.once('connect', () => {
          this.pipe = socket;
          this.setupPipeHandlers();
          resolve();
        });

        socket.once('error', () => {
          // Pipe not ready yet, retry
          socket.destroy();
          setTimeout(attempt, retryIntervalMs);
        });
      };

      attempt();
    });
  }

  /** Set up data and error handlers on the named pipe */
  private setupPipeHandlers(): void {
    if (!this.pipe) return;

    this.pipe.on('data', (data: Buffer) => {
      this.readBuffer += data.toString('utf-8');
      this.processReadBuffer();
    });

    this.pipe.on('error', (err) => {
      console.error(`[WebView2] Pipe error for session ${this.sessionId.slice(0, 8)}:`, err);
      this.cleanup(err.message);
    });

    this.pipe.on('close', () => {
      console.log(`[WebView2] Pipe closed for session ${this.sessionId.slice(0, 8)}`);
      this.cleanup('Pipe closed');
    });
  }

  /** Process the read buffer, extracting complete newline-delimited JSON messages */
  private processReadBuffer(): void {
    let newlineIdx: number;

    while ((newlineIdx = this.readBuffer.indexOf('\n')) !== -1) {
      const line = this.readBuffer.slice(0, newlineIdx).trim();
      this.readBuffer = this.readBuffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const message = JSON.parse(line);
        this.handleMessage(message);
      } catch (err) {
        console.warn(`[WebView2] Failed to parse message: ${line}`, err);
      }
    }
  }

  /** Handle a parsed JSON message from the helper */
  private handleMessage(message: Record<string, unknown>): void {
    const msgType = message.type as string;

    switch (msgType) {
      case 'ready':
        // Handled by waitForReady()
        this.emit('ready');
        break;

      case 'navigation_completed':
        this.currentUrl = message.url as string;
        this.emit('navigation-completed', {
          url: message.url as string,
          success: message.success as boolean,
          canGoBack: (message.can_go_back as boolean) ?? false,
          canGoForward: (message.can_go_forward as boolean) ?? false,
        });
        break;

      case 'title_changed':
        this.currentTitle = message.title as string;
        this.emit('title-changed', { title: message.title as string });
        break;

      case 'new_window':
      case 'new_window_requested':
        this.emit('new-window', message.url as string);
        break;

      case 'script_result': {
        const id = message.id as string;
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          clearTimeout(pending.timer);

          if (message.error) {
            pending.reject(new Error(message.error as string));
          } else {
            // ExecuteScriptAsync returns JSON-encoded results (e.g. strings
            // are wrapped in quotes: '"hello"'). Unwrap one JSON layer so
            // callers get raw values — matching Chromium's executeJavaScript.
            let result = message.result;
            if (typeof result === 'string') {
              try { result = JSON.parse(result); } catch { /* keep as-is */ }
            }
            pending.resolve(result);
          }
        }
        break;
      }

      case 'screenshot': {
        const id = message.id as string;
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          clearTimeout(pending.timer);

          if (message.error) {
            pending.reject(new Error(message.error as string));
          } else {
            pending.resolve(message.data as string);
          }
        }
        break;
      }

      case 'download_starting':
        this.emit('download-starting', {
          downloadId: message.id as string,
          url: message.url as string,
          filename: (message.title as string) ?? 'download',
          totalBytes: parseInt(message.data as string, 10) || 0,
          mimeType: (message.result as string) ?? '',
        });
        break;

      case 'download_progress':
        this.emit('download-progress', {
          downloadId: message.id as string,
          receivedBytes: parseInt(message.data as string, 10) || 0,
          totalBytes: parseInt(message.result as string, 10) || 0,
        });
        break;

      case 'download_done':
        this.emit('download-done', {
          downloadId: message.id as string,
          state: message.data as string,
          savePath: message.url as string,
        });
        break;

      case 'error':
        console.error(`[WebView2] Helper error: ${message.message}`);
        this.emit('error', new Error(message.message as string));
        break;

      default:
        console.warn(`[WebView2] Unknown message type: ${msgType}`);
    }
  }

  /** Wait for the ready message from the helper, with timeout */
  private waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('ready', onReady);
        reject(new Error(`WebView2 helper did not send ready message within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);

      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };

      this.once('ready', onReady);
    });
  }

  /** Send a JSON message to the helper via the named pipe */
  private sendMessage(message: Record<string, unknown>): void {
    if (!this.pipe || this.pipe.destroyed) {
      if (!this._closed) {
        console.warn(`[WebView2] Cannot send message — pipe not connected (session ${this.sessionId.slice(0, 8)})`);
      }
      return;
    }

    const json = JSON.stringify(message) + '\n';
    this.pipe.write(json);
  }

  /** Clean up all resources: reject pending requests, destroy pipe, null out process */
  private cleanup(reason: string | null): void {
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason ?? 'Session closed'));
      this.pendingRequests.delete(id);
    }

    // Destroy pipe connection
    if (this.pipe && !this.pipe.destroyed) {
      this.pipe.destroy();
    }
    this.pipe = null;

    // Clear read buffer
    this.readBuffer = '';

    // Mark as closed and emit
    if (!this._closed) {
      this._closed = true;
      this.emit('closed', reason);
    }

    this.process = null;
  }
}
