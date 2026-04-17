/**
 * FreeRDP engine — manages the conduit-freerdp helper subprocess.
 *
 * Communicates via:
 *   stdin:  JSON-newline commands (connect, mouse, keyboard, disconnect)
 *   stdout: Binary-framed messages (connected, bitmap_update, disconnected, error)
 *   stderr: Log messages (forwarded to console)
 *
 * Binary protocol (stdout):
 *   Header: [type:u32-LE][length:u32-LE]
 *   Types:
 *     0x01 CONNECTED    → JSON {"width":N,"height":N}
 *     0x02 BITMAP_UPDATE → [x:u16-LE][y:u16-LE][w:u16-LE][h:u16-LE][rgba_data...]
 *     0x03 DISCONNECTED → JSON {"error":null|"..."}
 *     0x04 RESIZED      → JSON {"width":N,"height":N}
 *     0xFF ERROR        → JSON {"message":"..."}
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveHostname } from '../../dns-resolver.js';
import type {
  RdpEngine,
  RdpEngineConfig,
  RdpBitmapUpdate,
  DesktopDimensions,
  OnBitmapCallback,
  OnCloseCallback,
  OnResizeCallback,
  OnClipboardCallback,
  OnClipboardFilesCallback,
  OnClipboardFileDoneCallback,
  OnClipboardFileErrorCallback,
  OnClipboardFileProgressCallback,
  OnCursorCallback,
  OnCursorNullCallback,
  OnCursorDefaultCallback,
} from '../engine.js';
import { getFreeRdpBinaryPath } from './factory.js';

/* Binary protocol message types */
const MSG_CONNECTED = 0x01;
const MSG_BITMAP_UPDATE = 0x02;
const MSG_DISCONNECTED = 0x03;
const MSG_RESIZED = 0x04;
const MSG_CLIPBOARD_TEXT = 0x05;
const MSG_CLIPBOARD_FILE_LIST = 0x06;
const MSG_CLIPBOARD_FILE_DONE = 0x07;
const MSG_CLIPBOARD_FILE_ERROR = 0x08;
const MSG_CLIPBOARD_FILE_PROGRESS = 0x09;
const MSG_CLIPBOARD_NATIVE = 0x0A;
const MSG_CURSOR_SET = 0x0B;
const MSG_CURSOR_NULL = 0x0C;
const MSG_CURSOR_DEFAULT = 0x0D;
const MSG_ERROR = 0xFF;

/* Parse state machine for reassembling binary frames from stdout */
const enum ParseState {
  HEADER,  // Reading 8-byte header
  PAYLOAD, // Reading N-byte payload
}

export class FreeRdpEngine implements RdpEngine {
  readonly engineType = 'freerdp' as const;

  private process: ChildProcess | null = null;
  private _connected = false;
  private _nativeClipboardActive = false;
  private dimensions: DesktopDimensions = { width: 0, height: 0 };

  /* Callbacks set during connect() */
  private onBitmap: OnBitmapCallback | null = null;
  private onClose: OnCloseCallback | null = null;
  private onResize: OnResizeCallback | null = null;
  private onClipboard: OnClipboardCallback | null = null;
  private onClipboardFiles: OnClipboardFilesCallback | null = null;
  private onClipboardFileDone: OnClipboardFileDoneCallback | null = null;
  private onClipboardFileError: OnClipboardFileErrorCallback | null = null;
  private onClipboardFileProgress: OnClipboardFileProgressCallback | null = null;
  private onCursor: OnCursorCallback | null = null;
  private onCursorNull: OnCursorNullCallback | null = null;
  private onCursorDefault: OnCursorDefaultCallback | null = null;

  /* Binary protocol parser state — uses chunk list to avoid O(n²) concat */
  private parseState: ParseState = ParseState.HEADER;
  private parseBuffer: Buffer = Buffer.alloc(0);
  private pendingChunks: Buffer[] = [];
  private pendingTotalBytes = 0;
  private msgType = 0;
  private msgLength = 0;

  /* Connect promise resolution */
  private connectResolve: ((dims: DesktopDimensions) => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  get connected(): boolean {
    return this._connected;
  }

  get nativeClipboardActive(): boolean {
    return this._nativeClipboardActive;
  }

  async connect(
    config: RdpEngineConfig,
    onBitmap: OnBitmapCallback,
    onClose: OnCloseCallback,
    onResize?: OnResizeCallback,
    onClipboard?: OnClipboardCallback,
    onClipboardFiles?: OnClipboardFilesCallback,
    onClipboardFileDone?: OnClipboardFileDoneCallback,
    onClipboardFileError?: OnClipboardFileErrorCallback,
    onClipboardFileProgress?: OnClipboardFileProgressCallback,
    onCursor?: OnCursorCallback,
    onCursorNull?: OnCursorNullCallback,
    onCursorDefault?: OnCursorDefaultCallback,
  ): Promise<DesktopDimensions> {
    this.onBitmap = onBitmap;
    this.onClose = onClose;
    this.onResize = onResize ?? null;
    this.onClipboard = onClipboard ?? null;
    this.onClipboardFiles = onClipboardFiles ?? null;
    this.onClipboardFileDone = onClipboardFileDone ?? null;
    this.onClipboardFileError = onClipboardFileError ?? null;
    this.onClipboardFileProgress = onClipboardFileProgress ?? null;
    this.onCursor = onCursor ?? null;
    this.onCursorNull = onCursorNull ?? null;
    this.onCursorDefault = onCursorDefault ?? null;

    const binaryPath = getFreeRdpBinaryPath();
    const binaryDir = dirname(binaryPath);
    const osslModulesDir = join(binaryDir, 'ossl-modules');
    console.log(`[FreeRDP] Spawning helper: ${binaryPath}`);
    console.log(`[FreeRDP] OPENSSL_MODULES=${osslModulesDir} (exists: ${existsSync(osslModulesDir)})`);

    this.process = spawn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENSSL_MODULES: join(binaryDir, 'ossl-modules'),
      },
    });

    /* Forward stderr to console (FreeRDP errors only — WLog set to ERROR level) */
    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        for (const line of msg.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          /* Filter noisy FreeRDP internal warnings */
          if (trimmed.includes('pthread_setschedprio') ||
              trimmed.includes('check_open_close_receive')) continue;
          console.log(`[FreeRDP] ${trimmed}`);
        }
      }
    });

    /* Parse binary protocol from stdout */
    this.process.stdout?.on('data', (data: Buffer) => {
      this.feedData(data);
    });

    /* Handle process exit */
    this.process.on('exit', (code, signal) => {
      console.log(`[FreeRDP] Process exited: code=${code}, signal=${signal}`);
      this._connected = false;
      this.process = null;

      if (this.connectReject) {
        this.connectReject(new Error(`FreeRDP process exited unexpectedly (code=${code})`));
        this.connectResolve = null;
        this.connectReject = null;
      }

      if (this.onClose) {
        this.onClose(code !== 0 ? `Process exited with code ${code}` : null);
      }
    });

    this.process.on('error', (err) => {
      console.error(`[FreeRDP] Process error:`, err);
      if (this.connectReject) {
        this.connectReject(err);
        this.connectResolve = null;
        this.connectReject = null;
      }
    });

    /* Pre-resolve hostname for diagnostics. We pass the original hostname
     * to FreeRDP (not the resolved IP) so TLS certificate CN matching works.
     * FreeRDP's own getaddrinfo() works now that we call WSAStartup() early. */
    const targetHost = config.hostname || config.host;
    await resolveHostname(targetHost); // diagnostic logging only

    /* Send connect command */
    return new Promise<DesktopDimensions>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      const connectCmd = JSON.stringify({
        type: 'connect',
        config: {
          host: targetHost,
          port: config.port,
          username: config.username,
          password: config.password,
          domain: config.domain || '',
          width: config.width,
          height: config.height,
          enableNla: config.enableNla,
          skipCertVerification: config.skipCertVerification,
          enableGfx: true,
          enableH264: true,
          drives: (config.sharedFolders || []).map(f => ({
            name: f.name,
            path: f.path,
          })),
          desktopScaleFactor: config.desktopScaleFactor ?? 100,
          deviceScaleFactor: config.deviceScaleFactor ?? 100,
          enableClipboard: config.enableClipboard ?? true,
        },
      });

      this.sendCommand(connectCmd);
    });
  }

  mouseMove(x: number, y: number): void {
    this.sendCommand(JSON.stringify({ type: 'mouse_move', x, y }));
  }

  mouseButtonDown(x: number, y: number, button: number): void {
    this.sendCommand(JSON.stringify({ type: 'mouse_button_down', x, y, button }));
  }

  mouseButtonUp(x: number, y: number, button: number): void {
    this.sendCommand(JSON.stringify({ type: 'mouse_button_up', x, y, button }));
  }

  mouseScroll(x: number, y: number, delta: number, vertical: boolean): void {
    this.sendCommand(JSON.stringify({ type: 'mouse_scroll', x, y, delta, vertical }));
  }

  keyDown(scancode: number, extended: boolean): void {
    this.sendCommand(JSON.stringify({ type: 'key_down', scancode, extended }));
  }

  keyUp(scancode: number, extended: boolean): void {
    this.sendCommand(JSON.stringify({ type: 'key_up', scancode, extended }));
  }

  async getFrame(): Promise<Buffer> {
    // FreeRDP streams frames via callbacks, not on-demand
    return Buffer.alloc(0);
  }

  async getDimensions(): Promise<DesktopDimensions> {
    return this.dimensions;
  }

  sendClipboard(text: string): void {
    this.sendCommand(JSON.stringify({ type: 'clipboard_set', text }));
  }

  sendClipboardFiles(files: { path: string; name: string; size: number; isDirectory: boolean }[]): void {
    this.sendCommand(JSON.stringify({ type: 'clipboard_set_files', files }));
  }

  requestClipboardFiles(tempDir: string): void {
    this.sendCommand(JSON.stringify({ type: 'clipboard_request_files', tempDir }));
  }

  async resize(width: number, height: number, desktopScaleFactor?: number, deviceScaleFactor?: number): Promise<void> {
    this.sendCommand(JSON.stringify({
      type: 'resize',
      width,
      height,
      desktopScaleFactor: desktopScaleFactor ?? 100,
      deviceScaleFactor: deviceScaleFactor ?? 100,
    }));
  }

  async close(): Promise<void> {
    if (this.process) {
      this.sendCommand(JSON.stringify({ type: 'disconnect' }));

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            this.process.kill();
          }
          resolve();
        }, 3000);

        if (this.process) {
          this.process.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });

      this.process = null;
    }
    this._connected = false;
  }

  /* ── Private methods ──────────────────────────────────────────────── */

  private sendCommand(json: string): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(json + '\n');
    }
  }

  /**
   * Feed raw data from stdout into the binary protocol parser.
   *
   * Uses a chunk list to avoid O(n²) Buffer.concat on every data event.
   * Chunks are accumulated in an array and only consolidated (concat'd)
   * when enough data is available to parse a complete message.
   */
  private feedData(data: Buffer): void {
    this.pendingChunks.push(data);
    this.pendingTotalBytes += data.length;

    while (true) {
      const needed = this.parseState === ParseState.HEADER ? 8 : this.msgLength;
      if (this.pendingTotalBytes < needed) break;

      /* Consolidate pending chunks into parseBuffer */
      if (this.pendingChunks.length > 0) {
        const parts = this.parseBuffer.length > 0
          ? [this.parseBuffer, ...this.pendingChunks]
          : this.pendingChunks;
        this.parseBuffer = Buffer.concat(parts);
        this.pendingChunks = [];
        this.pendingTotalBytes = this.parseBuffer.length;
      }

      if (this.parseState === ParseState.HEADER) {
        this.msgType = this.parseBuffer.readUInt32LE(0);
        this.msgLength = this.parseBuffer.readUInt32LE(4);
        this.parseBuffer = this.parseBuffer.subarray(8);
        this.pendingTotalBytes -= 8;
        this.parseState = ParseState.PAYLOAD;
        continue; /* Check payload availability immediately */
      }

      /* ParseState.PAYLOAD */
      const payload = this.parseBuffer.subarray(0, this.msgLength);
      this.parseBuffer = this.parseBuffer.subarray(this.msgLength);
      this.pendingTotalBytes -= this.msgLength;
      this.parseState = ParseState.HEADER;

      this.handleMessage(this.msgType, payload);
    }
  }

  /**
   * Handle a fully parsed binary message.
   */
  private handleMessage(type: number, payload: Buffer): void {
    switch (type) {
      case MSG_CONNECTED: {
        const json = JSON.parse(payload.toString());
        this.dimensions = { width: json.width, height: json.height };
        this._connected = true;
        console.log(`[FreeRDP] Connected: ${json.width}x${json.height}`);

        if (this.connectResolve) {
          this.connectResolve(this.dimensions);
          this.connectResolve = null;
          this.connectReject = null;
        }
        break;
      }

      case MSG_BITMAP_UPDATE: {
        if (payload.length < 8) break;

        const x = payload.readUInt16LE(0);
        const y = payload.readUInt16LE(2);
        const w = payload.readUInt16LE(4);
        const h = payload.readUInt16LE(6);
        const rgbaData = payload.subarray(8);

        const update: RdpBitmapUpdate = {
          x, y, width: w, height: h,
          data: Buffer.from(rgbaData), // Copy to decouple from parser buffer
        };

        if (this.onBitmap) {
          this.onBitmap(update);
        }
        break;
      }

      case MSG_DISCONNECTED: {
        const json = JSON.parse(payload.toString());
        this._connected = false;

        if (this.onClose) {
          this.onClose(json.error || null);
        }

        // Kill the zombie process — event loop has exited but command_loop is still alive
        if (this.process) {
          this.process.kill();
        }
        break;
      }

      case MSG_RESIZED: {
        const json = JSON.parse(payload.toString());
        this.dimensions = { width: json.width, height: json.height };

        if (this.onResize) {
          this.onResize(this.dimensions);
        }
        break;
      }

      case MSG_CLIPBOARD_TEXT: {
        const text = payload.toString('utf-8');
        console.log(`[FreeRDP] Clipboard text received: ${text.length} chars`);
        if (this.onClipboard) {
          this.onClipboard(text);
        }
        break;
      }

      case MSG_CLIPBOARD_FILE_LIST: {
        try {
          const json = JSON.parse(payload.toString());
          console.log(`[FreeRDP] Clipboard file list: ${json.files?.length ?? 0} files`);
          if (this.onClipboardFiles && json.files) {
            this.onClipboardFiles(json.files);
          }
        } catch (e) {
          console.error(`[FreeRDP] Failed to parse clipboard file list:`, e);
        }
        break;
      }

      case MSG_CLIPBOARD_FILE_DONE: {
        try {
          const json = JSON.parse(payload.toString());
          console.log(`[FreeRDP] Clipboard file done: ${json.name} (${json.size} bytes)`);
          if (this.onClipboardFileDone) {
            this.onClipboardFileDone(json);
          }
        } catch (e) {
          console.error(`[FreeRDP] Failed to parse clipboard file done:`, e);
        }
        break;
      }

      case MSG_CLIPBOARD_FILE_ERROR: {
        try {
          const json = JSON.parse(payload.toString());
          console.error(`[FreeRDP] Clipboard file error: file ${json.fileIndex}: ${json.error}`);
          if (this.onClipboardFileError) {
            this.onClipboardFileError(json.fileIndex, json.error);
          }
        } catch (e) {
          console.error(`[FreeRDP] Failed to parse clipboard file error:`, e);
        }
        break;
      }

      case MSG_CLIPBOARD_FILE_PROGRESS: {
        try {
          const json = JSON.parse(payload.toString());
          if (this.onClipboardFileProgress) {
            this.onClipboardFileProgress(json);
          }
        } catch (e) {
          console.error(`[FreeRDP] Failed to parse clipboard file progress:`, e);
        }
        break;
      }

      case MSG_CLIPBOARD_NATIVE: {
        this._nativeClipboardActive = true;
        console.log(`[FreeRDP] Native clipboard active — Electron clipboard polling disabled`);
        break;
      }

      case MSG_CURSOR_SET: {
        if (payload.length < 8) break;

        const hotspotX = payload.readUInt16LE(0);
        const hotspotY = payload.readUInt16LE(2);
        const cw = payload.readUInt16LE(4);
        const ch = payload.readUInt16LE(6);
        const expectedBytes = cw * ch * 4;
        if (payload.length < 8 + expectedBytes) break; // malformed frame
        const rgbaData = payload.subarray(8, 8 + expectedBytes);

        if (this.onCursor) {
          this.onCursor({
            hotspotX,
            hotspotY,
            width: cw,
            height: ch,
            data: Buffer.from(rgbaData),
          });
        }
        break;
      }

      case MSG_CURSOR_NULL: {
        if (this.onCursorNull) {
          this.onCursorNull();
        }
        break;
      }

      case MSG_CURSOR_DEFAULT: {
        if (this.onCursorDefault) {
          this.onCursorDefault();
        }
        break;
      }

      case MSG_ERROR: {
        const json = JSON.parse(payload.toString());
        console.error(`[FreeRDP] Error: ${json.message}`);

        if (this.connectReject) {
          this.connectReject(new Error(json.message));
          this.connectResolve = null;
          this.connectReject = null;
        }
        break;
      }

      default:
        console.warn(`[FreeRDP] Unknown message type: 0x${type.toString(16)}`);
    }
  }
}
