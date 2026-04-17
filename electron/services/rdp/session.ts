/**
 * RDP session lifecycle management.
 *
 * Manages RDP connection, frame buffer updates, and input handling.
 * Emits frame events to the Electron renderer process for canvas rendering.
 */

import { BrowserWindow, clipboard } from 'electron';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { FrameBuffer, type ImageFormat } from './framebuffer.js';
import type { RdpEngine, RdpEngineConfig, RdpBitmapUpdate, CursorUpdate, ClipboardFileInfo, ClipboardFileDownloaded, ClipboardFileProgress } from './engine.js';
import { createRdpEngine } from './engines/factory.js';
import { readClipboardFiles, writeClipboardFiles, clipboardHasFiles } from './clipboard-files.js';
import * as input from './input.js';

export type RdpSessionState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting';

/** A dirty region with its RGBA pixel data */
interface DirtyRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Buffer;
}

export class RdpSession {
  readonly id: string;
  readonly config: RdpEngineConfig;

  private state: RdpSessionState = 'disconnected';
  private frameBuffer: FrameBuffer;
  private engine: RdpEngine | null = null;
  private window: BrowserWindow | null = null;

  /** Batch frame emissions — accumulates bitmap updates within a 2ms window */
  private frameEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRegions: DirtyRegion[] = [];

  /** File clipboard state */
  private remoteFiles: ClipboardFileInfo[] = [];
  private fileTransferTempDir: string | null = null;
  private pendingFileDownloads = 0;
  private downloadedFilePaths: string[] = [];
  /** Keep old temp dirs until disconnect so clipboard file references stay valid */
  private oldTempDirs: string[] = [];
  /** Track local files being uploaded (for progress display) */
  private localUploadFiles: { name: string; size: number }[] = [];
  /** Dedup: sorted file paths we last sent to remote — prevents re-announcing the same files */
  private lastSentFilePaths: string[] = [];
  /** Throttle progress events to renderer (max ~10/sec) */
  private lastProgressEmit = 0;
  /** Suppress local→remote sync briefly after writing to clipboard (prevents echo) */
  private clipboardWriteSuppress = 0;
  /** Dedup: last remote clipboard text + timestamp to suppress duplicate notifications */
  private lastRemoteClipboardText = '';
  private lastRemoteClipboardTime = 0;
  /** Cache for cursor data URIs to avoid re-encoding identical cursors */
  private cursorCache = new Map<string, { dataUrl: string; hotspotX: number; hotspotY: number }>();
  /** Current desktop scale factor (100 = 1x, 200 = 2x Retina, etc.) */
  private currentScaleFactor = 100;

  constructor(id: string, config: RdpEngineConfig) {
    this.id = id;
    this.config = config;
    this.frameBuffer = new FrameBuffer(config.width, config.height);
    this.currentScaleFactor = config.desktopScaleFactor ?? 100;
  }

  /** Current session state */
  getState(): RdpSessionState {
    return this.state;
  }

  /** Whether the session is connected */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /** Get frame buffer dimensions */
  getDimensions(): { width: number; height: number } {
    return this.frameBuffer.getDimensions();
  }

  /** Set the BrowserWindow to emit frame events to */
  setWindow(window: BrowserWindow): void {
    this.window = window;
  }

  /**
   * Connect to the RDP server using the configured engine.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.state !== 'disconnected') {
        reject(new Error('Already connected or connecting'));
        return;
      }

      this.state = 'connecting';
      this.engine = createRdpEngine();

      this.engine.connect(
        this.config,
        // Bitmap update callback (streaming frames from engine)
        (update: RdpBitmapUpdate) => {
          this.handleBitmapUpdate(update);
        },
        // Close callback
        (error: string | null) => {
          const wasConnecting = this.state === 'connecting';
          this.state = 'disconnected';
          if (error) {
            console.error(`RDP session ${this.id} closed with error: ${error}`);
          }
          // Notify renderer so it can show disconnect state
          if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send('rdp:status', {
              sessionId: this.id,
              status: 'disconnected',
              error: error || null,
            });
          }
          // If we're still waiting to resolve the connect promise, this is unexpected
          if (wasConnecting) {
            reject(new Error(error || 'Connection closed during setup'));
          }
        },
        // Resize callback (server-initiated after display control resize)
        (dims) => {
          this.handleServerResize(dims.width, dims.height);
        },
        // Clipboard callback (remote clipboard text received)
        (text) => {
          this.handleRemoteClipboard(text);
        },
        // Clipboard file list callback (remote files available)
        (files) => {
          this.handleRemoteFilesAvailable(files);
        },
        // Clipboard file done callback (individual file downloaded)
        (file) => {
          this.handleRemoteFileDone(file);
        },
        // Clipboard file error callback
        (fileIndex, error) => {
          console.error(`[RDP ${this.id}] File download error: file ${fileIndex}: ${error}`);
          this.pendingFileDownloads = Math.max(0, this.pendingFileDownloads - 1);
          this.checkAllFilesComplete();
        },
        // Clipboard file progress callback
        (progress) => {
          this.handleFileProgress(progress);
        },
        // Cursor set callback (custom cursor from remote)
        (cursor) => {
          this.handleCursorSet(cursor);
        },
        // Cursor null callback (hide cursor)
        () => {
          this.handleCursorNull();
        },
        // Cursor default callback (system default cursor)
        () => {
          this.handleCursorDefault();
        },
      ).then((dims) => {
        // Resize framebuffer to match server's desktop size
        this.frameBuffer.resize(dims.width, dims.height);
        this.state = 'connected';
        resolve();
      }).catch((err) => {
        this.state = 'disconnected';
        this.engine = null;
        reject(err);
      });
    });
  }

  /**
   * Request a resize of the remote desktop via RDPEDISP.
   *
   * With GFX pipeline enabled, the server responds with a GFX reset
   * (not a DeactivateAll PDU), which FreeRDP handles internally via
   * cb_desktop_resize. Dimensions are clamped to 200-8192 and rounded
   * to even numbers.
   *
   * If RDPEDISP is unsupported, the request is silently ignored and
   * CSS scaling continues to work as a fallback.
   */
  async resize(width: number, height: number, desktopScaleFactor?: number, deviceScaleFactor?: number): Promise<void> {
    if (!this.engine || !this.isConnected()) {
      return;
    }

    // Clamp to valid range and ensure even dimensions
    width = Math.max(200, Math.min(8192, width));
    height = Math.max(200, Math.min(8192, height));
    width = width & ~1;
    height = height & ~1;

    // Skip if dimensions match current framebuffer
    const current = this.frameBuffer.getDimensions();
    if (width === current.width && height === current.height) {
      return;
    }

    // Track current scale factor for cursor sizing
    if (desktopScaleFactor && desktopScaleFactor >= 100) {
      this.currentScaleFactor = desktopScaleFactor;
      // Invalidate cursor cache — scale changed, all cached cursors are wrong size
      this.cursorCache.clear();
    }

    await this.engine.resize(width, height, desktopScaleFactor, deviceScaleFactor);
  }

  /** Disconnect the session gracefully */
  async disconnect(): Promise<void> {
    if (this.state === 'disconnected' || this.state === 'disconnecting') {
      return;
    }

    this.state = 'disconnecting';

    if (this.frameEmitTimer) {
      clearTimeout(this.frameEmitTimer);
      this.frameEmitTimer = null;
    }
    this.pendingRegions = [];

    if (this.engine) {
      await this.engine.close();
      this.engine = null;
    }

    // Clean up temp dir
    this.cleanupTempDir();

    this.state = 'disconnected';
  }

  /** Take a screenshot of the current frame buffer */
  async screenshot(format: ImageFormat = { type: 'png' }, maxWidth?: number): Promise<{ buffer: Buffer; width: number; height: number }> {
    return this.frameBuffer.encode(format, maxWidth);
  }

  /** Take a screenshot of a region */
  async screenshotRegion(
    x: number,
    y: number,
    width: number,
    height: number,
    format: ImageFormat = { type: 'png' },
    maxWidth?: number,
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    return this.frameBuffer.extractRegion(x, y, width, height, format, maxWidth);
  }

  /** Get raw RGBA frame data (for canvas rendering) */
  getFrameData(): Buffer {
    return this.frameBuffer.toRgba();
  }

  // === Input Methods ===

  /** Send a mouse click */
  mouseClick(x: number, y: number, button: input.MouseButton = 'left'): void {
    if (!this.engine || !this.isConnected()) return;
    const btn = buttonToNumber(button);
    this.engine.mouseButtonDown(x, y, btn);
    this.engine.mouseButtonUp(x, y, btn);
  }

  /** Send a mouse double-click */
  mouseDoubleClick(x: number, y: number, button: input.MouseButton = 'left'): void {
    this.mouseClick(x, y, button);
    this.mouseClick(x, y, button);
  }

  /** Send a mouse button down (for drag support and separate press/release) */
  mouseDown(x: number, y: number, button: input.MouseButton = 'left'): void {
    if (!this.engine || !this.isConnected()) return;
    this.engine.mouseButtonDown(x, y, buttonToNumber(button));
  }

  /** Send a mouse button up */
  mouseUp(x: number, y: number, button: input.MouseButton = 'left'): void {
    if (!this.engine || !this.isConnected()) return;
    this.engine.mouseButtonUp(x, y, buttonToNumber(button));
  }

  /** Send a mouse move */
  mouseMove(x: number, y: number): void {
    if (!this.engine || !this.isConnected()) return;
    this.engine.mouseMove(x, y);
  }

  /** Send a mouse drag */
  mouseDrag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    button: input.MouseButton = 'left',
  ): void {
    if (!this.engine || !this.isConnected()) return;
    const btn = buttonToNumber(button);

    // Press at start
    this.engine.mouseButtonDown(fromX, fromY, btn);

    // Interpolate intermediate move events
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(fromX + (toX - fromX) * t);
      const y = Math.round(fromY + (toY - fromY) * t);
      this.engine.mouseMove(x, y);
    }

    // Release at end
    this.engine.mouseButtonUp(toX, toY, btn);
  }

  /** Send a mouse scroll */
  mouseScroll(x: number, y: number, delta: number, vertical: boolean = true): void {
    if (!this.engine || !this.isConnected()) return;
    this.engine.mouseScroll(x, y, delta, vertical);
  }

  /** Send a key press with optional modifiers */
  sendKey(key: string, modifiers: string[] = []): void {
    if (!this.engine || !this.isConnected()) return;
    input.sendKeyWithModifiers(this, key, modifiers);
  }

  /** Type a string of text */
  async typeText(text: string, delayMs: number = 20): Promise<void> {
    if (!this.engine || !this.isConnected()) return;
    await input.sendText(this, text, delayMs);
  }

  /** Send raw key down event */
  keyDown(key: string, code: string, _modifiers: string[] = []): void {
    if (!this.engine || !this.isConnected()) return;
    const sc = codeToScancode(code);
    this.engine.keyDown(sc.scancode, sc.extended);
  }

  /** Send raw key up event */
  keyUp(key: string, code: string): void {
    if (!this.engine || !this.isConnected()) return;
    const sc = codeToScancode(code);
    this.engine.keyUp(sc.scancode, sc.extended);
  }

  /** Send a raw scancode key event (for input.ts compatibility) */
  sendKeyEventScancode(scancode: number, isPressed: boolean, extended: boolean = false): void {
    if (!this.engine || !this.isConnected()) return;
    if (isPressed) {
      this.engine.keyDown(scancode, extended);
    } else {
      this.engine.keyUp(scancode, extended);
    }
  }

  // === Clipboard Methods ===

  /** Send local clipboard text to the remote desktop */
  sendClipboard(text: string): void {
    if (!this.engine || !this.isConnected()) return;
    this.engine.sendClipboard(text);
  }

  /** Handle text received from remote desktop clipboard */
  private handleRemoteClipboard(text: string): void {
    // Dedup: suppress duplicate clipboard text within 2 seconds (servers often send duplicates)
    const now = Date.now();
    if (text === this.lastRemoteClipboardText && now - this.lastRemoteClipboardTime < 2000) {
      return;
    }
    this.lastRemoteClipboardText = text;
    this.lastRemoteClipboardTime = now;

    // Native clipboard (Windows): C helper already wrote to native clipboard
    if (!this.engine?.nativeClipboardActive) {
      clipboard.writeText(text);
      // Suppress next sync so we don't echo this text back to remote
      this.clipboardWriteSuppress = Date.now() + 2000;
    }
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('rdp:clipboard', {
        sessionId: this.id,
        text,
      });
    }
  }

  // === File Clipboard Methods ===

  /** Read local system clipboard and send to remote (files or text) */
  syncLocalClipboardToRemote(): void {
    if (!this.engine || !this.isConnected()) return;

    // Native clipboard (Windows): C helper detects local changes directly
    if (this.engine.nativeClipboardActive) return;

    // Suppress echo: we just wrote to the clipboard, don't re-announce it
    if (Date.now() < this.clipboardWriteSuppress) {
      console.log(`[RDP ${this.id}] Skipping local→remote sync (clipboard write suppression)`);
      return;
    }

    // Don't overwrite server's clipboard claim while downloading remote files
    if (this.pendingFileDownloads > 0 || this.remoteFiles.length > 0) {
      console.log(`[RDP ${this.id}] Skipping local→remote sync (remote files pending)`);
      return;
    }

    const formats = clipboard.availableFormats();
    const hasFiles = clipboardHasFiles();
    console.log(`[RDP ${this.id}] syncLocalClipboardToRemote: formats=${JSON.stringify(formats)}, hasFiles=${hasFiles}`);

    // Check for files first — they take priority
    if (hasFiles) {
      const filePaths = readClipboardFiles();
      console.log(`[RDP ${this.id}] readClipboardFiles result:`, filePaths);
      if (filePaths && filePaths.length > 0) {
        // Skip if the same files are already staged on the remote clipboard
        const sorted = [...filePaths].sort();
        if (sorted.length === this.lastSentFilePaths.length &&
            sorted.every((p, i) => p === this.lastSentFilePaths[i])) {
          console.log(`[RDP ${this.id}] Skipping duplicate file clipboard sync (same files already sent)`);
          return;
        }

        const files = this.expandClipboardPaths(filePaths);

        console.log(`[RDP ${this.id}] Sending ${files.length} local files to remote clipboard:`, files.map(f => f.name));
        this.lastSentFilePaths = sorted;
        this.localUploadFiles = files.map(f => ({ name: f.name, size: f.size }));
        this.engine.sendClipboardFiles(files);
        return;
      }
    }

    // Fall back to text — clipboard no longer has files
    this.lastSentFilePaths = [];
    const text = clipboard.readText();
    if (text) {
      console.log(`[RDP ${this.id}] Sending text to remote clipboard (${text.length} chars)`);
      this.engine.sendClipboard(text);
    }
  }

  /** Request download of remote clipboard files */
  requestRemoteFiles(): void {
    if (!this.engine || !this.isConnected()) return;
    if (this.remoteFiles.length === 0) return;

    // Preserve old temp dir (clipboard may still reference its files)
    if (this.fileTransferTempDir) {
      this.oldTempDirs.push(this.fileTransferTempDir);
    }
    this.fileTransferTempDir = mkdtempSync(join(tmpdir(), 'conduit-rdp-clip-'));
    this.pendingFileDownloads = this.remoteFiles.length;
    this.downloadedFilePaths = [];

    console.log(`[RDP ${this.id}] Requesting ${this.remoteFiles.length} files → ${this.fileTransferTempDir}`);
    this.engine.requestClipboardFiles(this.fileTransferTempDir);
  }

  /** Get the list of remote files available for download */
  getRemoteFiles(): ClipboardFileInfo[] {
    return this.remoteFiles;
  }

  /** Dismiss remote file notification and clear blocking state */
  dismissRemoteFiles(): void {
    this.remoteFiles = [];
    this.pendingFileDownloads = 0;
  }

  /** Auto-download threshold: files under 10MB are downloaded automatically */
  private static readonly AUTO_DOWNLOAD_THRESHOLD = 10 * 1024 * 1024;

  /** Handle notification that remote clipboard has files */
  private handleRemoteFilesAvailable(files: ClipboardFileInfo[]): void {
    // Skip if we already downloaded these exact files (server re-announces after unlock)
    if (this.downloadedFilePaths.length > 0 && this.remoteFiles.length === files.length) {
      const sameFiles = files.every((f, i) =>
        this.remoteFiles[i]?.name === f.name && this.remoteFiles[i]?.size === f.size);
      if (sameFiles) {
        console.log(`[RDP ${this.id}] Server re-announced same ${files.length} files, skipping re-download`);
        return;
      }
    }

    this.remoteFiles = files;
    this.downloadedFilePaths = [];
    // Remote clipboard now owns files — reset local file dedup so next local copy is fresh
    this.lastSentFilePaths = [];

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    console.log(`[RDP ${this.id}] Remote clipboard has ${files.length} files (${totalSize} bytes)`);

    // Auto-download small files silently
    if (totalSize <= RdpSession.AUTO_DOWNLOAD_THRESHOLD) {
      console.log(`[RDP ${this.id}] Auto-downloading (under ${RdpSession.AUTO_DOWNLOAD_THRESHOLD / 1024 / 1024}MB threshold)`);
      this.requestRemoteFiles();
      return;
    }

    // Large files: notify renderer so user can click Download
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('rdp:clipboard-files-available', {
        sessionId: this.id,
        files,
      });
    }
  }

  /** Handle a completed file download */
  private handleRemoteFileDone(file: ClipboardFileDownloaded): void {
    this.downloadedFilePaths.push(file.tempPath);
    this.pendingFileDownloads = Math.max(0, this.pendingFileDownloads - 1);

    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('rdp:clipboard-file-done', {
        sessionId: this.id,
        ...file,
      });
    }

    this.checkAllFilesComplete();
  }

  /** Check if all files are downloaded and write to clipboard */
  private checkAllFilesComplete(): void {
    if (this.pendingFileDownloads > 0) return;

    if (this.downloadedFilePaths.length > 0) {
      // Only put root-level items on the clipboard. When a folder is copied
      // from the remote, the FGD includes both the directory and each nested
      // file as separate entries. If we put them all on the clipboard, pasting
      // dumps everything flat instead of preserving the directory structure.
      // Finder/Explorer naturally copies directory contents when pasting a dir.
      const rootPaths = this.getRootLevelClipboardPaths(this.downloadedFilePaths);

      // Native clipboard (Windows): C helper already placed CF_HDROP on native clipboard
      if (this.engine?.nativeClipboardActive) {
        console.log(`[RDP ${this.id}] All ${this.downloadedFilePaths.length} files downloaded (native clipboard handled by C helper)`);
      } else {
        console.log(`[RDP ${this.id}] All ${this.downloadedFilePaths.length} files downloaded, writing ${rootPaths.length} root items to clipboard:`, rootPaths);
        const wrote = writeClipboardFiles(rootPaths);
        console.log(`[RDP ${this.id}] writeClipboardFiles result: ${wrote}`);
        // Suppress next sync so we don't echo these files back to remote
        this.clipboardWriteSuppress = Date.now() + 2000;
      }

      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send('rdp:clipboard-files-complete', {
          sessionId: this.id,
          files: this.downloadedFilePaths,
        });
      }
    }

    // Clear remote file state so local→remote sync can resume
    this.remoteFiles = [];
    this.pendingFileDownloads = 0;
  }

  /**
   * Filter downloaded file paths to only root-level items (direct children
   * of the temp dir). Nested files inside directories are excluded because
   * Finder/Explorer will copy directory contents automatically when pasting.
   */
  private getRootLevelClipboardPaths(paths: string[]): string[] {
    if (!this.fileTransferTempDir) return paths;

    const tempDir = this.fileTransferTempDir;
    const seen = new Set<string>();
    const rootPaths: string[] = [];

    for (const p of paths) {
      // Compute relative path from temp dir
      const prefix = tempDir + sep;
      if (!p.startsWith(prefix)) continue;
      const rel = p.substring(prefix.length);
      if (!rel) continue;

      // First path component = the root-level item name
      const sepIdx = rel.indexOf(sep);
      const rootName = sepIdx >= 0 ? rel.substring(0, sepIdx) : rel;

      if (!seen.has(rootName)) {
        seen.add(rootName);
        rootPaths.push(join(tempDir, rootName));
      }
    }

    return rootPaths.length > 0 ? rootPaths : paths;
  }

  /**
   * Expand clipboard file paths for the FGD protocol. Directories are
   * recursively enumerated so every nested file and subdirectory gets its
   * own entry with a relative name (e.g. "MyFolder/sub/file.txt").
   * This is required by MS-RDPECLIP — the FGD must list every item.
   */
  private expandClipboardPaths(filePaths: string[]): { path: string; name: string; size: number; isDirectory: boolean }[] {
    const entries: { path: string; name: string; size: number; isDirectory: boolean }[] = [];

    for (const p of filePaths) {
      try {
        const stat = statSync(p);
        const baseName = p.split('/').pop() || p.split('\\').pop() || 'unknown';

        if (stat.isDirectory()) {
          entries.push({ path: p, name: baseName, size: 0, isDirectory: true });
          this.enumerateDirectoryRecursive(p, baseName, entries);
        } else {
          entries.push({ path: p, name: baseName, size: stat.size, isDirectory: false });
        }
      } catch {
        entries.push({ path: p, name: p.split('/').pop() || 'unknown', size: 0, isDirectory: false });
      }
    }

    return entries;
  }

  /** Recursively enumerate a directory, adding entries with relative names. */
  private enumerateDirectoryRecursive(
    dirPath: string,
    relativeName: string,
    entries: { path: string; name: string; size: number; isDirectory: boolean }[],
  ): void {
    try {
      const items = readdirSync(dirPath, { withFileTypes: true });
      for (const item of items) {
        // Skip hidden files (e.g. .DS_Store)
        if (item.name.startsWith('.')) continue;

        const fullPath = join(dirPath, item.name);
        const relName = relativeName + '/' + item.name;

        if (item.isDirectory()) {
          entries.push({ path: fullPath, name: relName, size: 0, isDirectory: true });
          this.enumerateDirectoryRecursive(fullPath, relName, entries);
        } else {
          try {
            const stat = statSync(fullPath);
            entries.push({ path: fullPath, name: relName, size: stat.size, isDirectory: false });
          } catch {
            entries.push({ path: fullPath, name: relName, size: 0, isDirectory: false });
          }
        }
      }
    } catch (e) {
      console.error(`[RDP ${this.id}] Failed to enumerate directory ${dirPath}:`, e);
    }
  }

  /** Handle file transfer progress — throttled to ~10 events/sec to renderer */
  private handleFileProgress(progress: ClipboardFileProgress): void {
    const now = Date.now();
    // Always forward near-completion events (>= 98%) so the frontend can dismiss the toast
    const pct = progress.totalSize > 0 ? progress.bytesTransferred / progress.totalSize : 0;
    if (pct < 0.98 && now - this.lastProgressEmit < 100) return;
    this.lastProgressEmit = now;

    if (this.window && !this.window.isDestroyed()) {
      // Enrich upload progress with file names from our stored state
      const fileNames = progress.direction === 'upload'
        ? this.localUploadFiles.map(f => f.name)
        : this.remoteFiles.map(f => f.name);
      const fileTotalSize = progress.direction === 'upload'
        ? this.localUploadFiles.reduce((s, f) => s + f.size, 0)
        : this.remoteFiles.reduce((s, f) => s + f.size, 0);

      this.window.webContents.send('rdp:clipboard-file-progress', {
        sessionId: this.id,
        ...progress,
        fileNames,
        fileTotalSize,
      });
    }
  }

  // === Cursor Methods ===

  /** Handle a custom cursor update from the remote session */
  private handleCursorSet(cursor: CursorUpdate): void {
    // On Retina/HiDPI the cursor image is at full RDP resolution. We send it
    // at full resolution plus the DPR scale so the renderer can use
    // -webkit-image-set() for crisp rendering at the correct CSS size.
    const dprScale = this.currentScaleFactor / 100; // e.g. 2.0 for Retina
    // Hotspot in CSS pixels (image-set handles the image scaling)
    const cssHotX = dprScale > 1 ? Math.round(cursor.hotspotX / dprScale) : cursor.hotspotX;
    const cssHotY = dprScale > 1 ? Math.round(cursor.hotspotY / dprScale) : cursor.hotspotY;

    // Cache key includes scale factor
    const keyPrefix = `${cursor.width}x${cursor.height}_${cursor.hotspotX}_${cursor.hotspotY}_s${this.currentScaleFactor}_`;
    const dataHash = createHash('md5').update(cursor.data).digest('base64');
    const cacheKey = keyPrefix + dataHash;

    const cached = this.cursorCache.get(cacheKey);
    if (cached) {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send('rdp:cursor', {
          sessionId: this.id,
          type: 'set',
          dataUrl: cached.dataUrl,
          hotspotX: cached.hotspotX,
          hotspotY: cached.hotspotY,
          scale: dprScale,
        });
      }
      return;
    }

    // Encode full-resolution RGBA to PNG — no resize, let the browser handle DPI
    sharp(cursor.data, {
      raw: { width: cursor.width, height: cursor.height, channels: 4 },
    })
      .png()
      .toBuffer()
      .then((png) => {
        const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

        // Cache it (limit cache to 100 entries)
        if (this.cursorCache.size >= 100) {
          const firstKey = this.cursorCache.keys().next().value;
          if (firstKey !== undefined) this.cursorCache.delete(firstKey);
        }
        this.cursorCache.set(cacheKey, {
          dataUrl,
          hotspotX: cssHotX,
          hotspotY: cssHotY,
        });

        if (this.window && !this.window.isDestroyed()) {
          this.window.webContents.send('rdp:cursor', {
            sessionId: this.id,
            type: 'set',
            dataUrl,
            hotspotX: cssHotX,
            hotspotY: cssHotY,
            scale: dprScale,
          });
        }
      })
      .catch((err) => {
        console.error(`[RDP ${this.id}] Cursor PNG encode failed:`, err);
      });
  }

  /** Handle cursor hide request from remote */
  private handleCursorNull(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('rdp:cursor', {
        sessionId: this.id,
        type: 'null',
      });
    }
  }

  /** Handle system default cursor request from remote */
  private handleCursorDefault(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('rdp:cursor', {
        sessionId: this.id,
        type: 'default',
      });
    }
  }

  /** Clean up all temp directories (current + old) */
  private cleanupTempDir(): void {
    const dirs = [...this.oldTempDirs];
    if (this.fileTransferTempDir) dirs.push(this.fileTransferTempDir);
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        console.error(`[RDP ${this.id}] Failed to cleanup temp dir:`, e);
      }
    }
    this.oldTempDirs = [];
    this.fileTransferTempDir = null;
  }

  // === Private Methods ===

  /** Send a full frame to the renderer (for initial paint or tab reactivation) */
  sendFullFrame(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const { width, height } = this.frameBuffer.getDimensions();
    if (width === 0 || height === 0) return;

    const data = this.frameBuffer.toRgba();
    this.window.webContents.send('rdp:frame', {
      sessionId: this.id,
      regions: [{ x: 0, y: 0, width, height, data }],
    });
  }

  /** Handle server-initiated resize (after RDPEDISP deactivation-reactivation) */
  private handleServerResize(width: number, height: number): void {
    // Clear stale pending regions from old dimensions
    if (this.frameEmitTimer) {
      clearTimeout(this.frameEmitTimer);
      this.frameEmitTimer = null;
    }
    this.pendingRegions = [];

    this.frameBuffer.resize(width, height);
    // Notify renderer of new dimensions
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('rdp:resize', {
        sessionId: this.id,
        width,
        height,
      });
    }
  }

  /** Handle an incoming bitmap update from the engine */
  private handleBitmapUpdate(update: RdpBitmapUpdate): void {
    // Accumulate dirty region for batch send
    this.pendingRegions.push({
      x: update.x,
      y: update.y,
      width: update.width,
      height: update.height,
      data: update.data,
    });

    this.scheduleFrameEmit();
  }

  /** Batch bitmap updates within a 2ms window before emitting to renderer.
   * This coalesces the initial desktop strips into a single IPC call. */
  private scheduleFrameEmit(): void {
    if (this.frameEmitTimer) return;
    this.frameEmitTimer = setTimeout(() => {
      this.frameEmitTimer = null;
      this.emitFrame();
    }, 2);
  }

  /**
   * Merge adjacent or overlapping dirty regions to reduce IPC overhead.
   * Uses simple bounding box expansion with a 10px threshold.
   */
  private mergeRegions(regions: DirtyRegion[]): DirtyRegion[] {
    if (regions.length <= 1) return regions;

    const merged: DirtyRegion[] = [];
    const sorted = [...regions].sort((a, b) => a.y - b.y || a.x - b.x);

    let current = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];

      // Check if regions are adjacent or overlapping (10px threshold)
      const xOverlap = current.x + current.width >= next.x - 10;
      const yOverlap = current.y + current.height >= next.y - 10;

      if (xOverlap && yOverlap) {
        // Merge into bounding box
        const x1 = Math.min(current.x, next.x);
        const y1 = Math.min(current.y, next.y);
        const x2 = Math.max(current.x + current.width, next.x + next.width);
        const y2 = Math.max(current.y + current.height, next.y + next.height);

        // Re-extract merged region from framebuffer
        current = {
          x: x1,
          y: y1,
          width: x2 - x1,
          height: y2 - y1,
          data: this.frameBuffer.extractRegionRaw(x1, y1, x2 - x1, y2 - y1),
        };
      } else {
        merged.push(current);
        current = next;
      }
    }

    merged.push(current);
    return merged;
  }

  /** Emit accumulated dirty regions to the renderer */
  private emitFrame(): void {
    if (this.pendingRegions.length === 0) return;

    // Apply regions to framebuffer (needed for screenshots and merging)
    for (const region of this.pendingRegions) {
      this.frameBuffer.updateRegionRgba(
        region.x,
        region.y,
        region.width,
        region.height,
        region.data,
        region.width * 4,
      );
    }

    if (this.window && !this.window.isDestroyed()) {
      const { width, height } = this.frameBuffer.getDimensions();
      const fullFrameSize = width * height * 4;

      // Calculate total bytes before merging
      let totalRegionBytes = 0;
      for (const r of this.pendingRegions) {
        totalRegionBytes += r.data.length;
      }

      if (totalRegionBytes >= fullFrameSize) {
        // Send full frame from framebuffer
        const data = this.frameBuffer.toRgba();
        this.window.webContents.send('rdp:frame', {
          sessionId: this.id,
          regions: [{ x: 0, y: 0, width, height, data }],
        });
      } else {
        // Merge adjacent regions to reduce IPC overhead
        const mergedRegions = this.mergeRegions(this.pendingRegions);

        // Send merged regions
        this.window.webContents.send('rdp:frame', {
          sessionId: this.id,
          regions: mergedRegions,
        });
      }
    }

    this.pendingRegions = [];
  }
}

/**
 * Map DOM KeyboardEvent.code to PS/2 scancode.
 */
function codeToScancode(code: string): { scancode: number; extended: boolean } {
  const CODE_MAP: Record<string, { scancode: number; extended: boolean }> = {
    'Escape': { scancode: 0x01, extended: false },
    'Digit1': { scancode: 0x02, extended: false },
    'Digit2': { scancode: 0x03, extended: false },
    'Digit3': { scancode: 0x04, extended: false },
    'Digit4': { scancode: 0x05, extended: false },
    'Digit5': { scancode: 0x06, extended: false },
    'Digit6': { scancode: 0x07, extended: false },
    'Digit7': { scancode: 0x08, extended: false },
    'Digit8': { scancode: 0x09, extended: false },
    'Digit9': { scancode: 0x0a, extended: false },
    'Digit0': { scancode: 0x0b, extended: false },
    'Minus': { scancode: 0x0c, extended: false },
    'Equal': { scancode: 0x0d, extended: false },
    'Backspace': { scancode: 0x0e, extended: false },
    'Tab': { scancode: 0x0f, extended: false },
    'KeyQ': { scancode: 0x10, extended: false },
    'KeyW': { scancode: 0x11, extended: false },
    'KeyE': { scancode: 0x12, extended: false },
    'KeyR': { scancode: 0x13, extended: false },
    'KeyT': { scancode: 0x14, extended: false },
    'KeyY': { scancode: 0x15, extended: false },
    'KeyU': { scancode: 0x16, extended: false },
    'KeyI': { scancode: 0x17, extended: false },
    'KeyO': { scancode: 0x18, extended: false },
    'KeyP': { scancode: 0x19, extended: false },
    'BracketLeft': { scancode: 0x1a, extended: false },
    'BracketRight': { scancode: 0x1b, extended: false },
    'Enter': { scancode: 0x1c, extended: false },
    'ControlLeft': { scancode: 0x1d, extended: false },
    'KeyA': { scancode: 0x1e, extended: false },
    'KeyS': { scancode: 0x1f, extended: false },
    'KeyD': { scancode: 0x20, extended: false },
    'KeyF': { scancode: 0x21, extended: false },
    'KeyG': { scancode: 0x22, extended: false },
    'KeyH': { scancode: 0x23, extended: false },
    'KeyJ': { scancode: 0x24, extended: false },
    'KeyK': { scancode: 0x25, extended: false },
    'KeyL': { scancode: 0x26, extended: false },
    'Semicolon': { scancode: 0x27, extended: false },
    'Quote': { scancode: 0x28, extended: false },
    'Backquote': { scancode: 0x29, extended: false },
    'ShiftLeft': { scancode: 0x2a, extended: false },
    'Backslash': { scancode: 0x2b, extended: false },
    'KeyZ': { scancode: 0x2c, extended: false },
    'KeyX': { scancode: 0x2d, extended: false },
    'KeyC': { scancode: 0x2e, extended: false },
    'KeyV': { scancode: 0x2f, extended: false },
    'KeyB': { scancode: 0x30, extended: false },
    'KeyN': { scancode: 0x31, extended: false },
    'KeyM': { scancode: 0x32, extended: false },
    'Comma': { scancode: 0x33, extended: false },
    'Period': { scancode: 0x34, extended: false },
    'Slash': { scancode: 0x35, extended: false },
    'ShiftRight': { scancode: 0x36, extended: false },
    'NumpadMultiply': { scancode: 0x37, extended: false },
    'AltLeft': { scancode: 0x38, extended: false },
    'Space': { scancode: 0x39, extended: false },
    'CapsLock': { scancode: 0x3a, extended: false },
    'F1': { scancode: 0x3b, extended: false },
    'F2': { scancode: 0x3c, extended: false },
    'F3': { scancode: 0x3d, extended: false },
    'F4': { scancode: 0x3e, extended: false },
    'F5': { scancode: 0x3f, extended: false },
    'F6': { scancode: 0x40, extended: false },
    'F7': { scancode: 0x41, extended: false },
    'F8': { scancode: 0x42, extended: false },
    'F9': { scancode: 0x43, extended: false },
    'F10': { scancode: 0x44, extended: false },
    'NumLock': { scancode: 0x45, extended: false },
    'ScrollLock': { scancode: 0x46, extended: false },
    'Numpad7': { scancode: 0x47, extended: false },
    'Numpad8': { scancode: 0x48, extended: false },
    'Numpad9': { scancode: 0x49, extended: false },
    'NumpadSubtract': { scancode: 0x4a, extended: false },
    'Numpad4': { scancode: 0x4b, extended: false },
    'Numpad5': { scancode: 0x4c, extended: false },
    'Numpad6': { scancode: 0x4d, extended: false },
    'NumpadAdd': { scancode: 0x4e, extended: false },
    'Numpad1': { scancode: 0x4f, extended: false },
    'Numpad2': { scancode: 0x50, extended: false },
    'Numpad3': { scancode: 0x51, extended: false },
    'Numpad0': { scancode: 0x52, extended: false },
    'NumpadDecimal': { scancode: 0x53, extended: false },
    'F11': { scancode: 0x57, extended: false },
    'F12': { scancode: 0x58, extended: false },
    // Extended keys
    'NumpadEnter': { scancode: 0x1c, extended: true },
    'ControlRight': { scancode: 0x1d, extended: true },
    'NumpadDivide': { scancode: 0x35, extended: true },
    'PrintScreen': { scancode: 0x37, extended: true },
    'AltRight': { scancode: 0x38, extended: true },
    'Home': { scancode: 0x47, extended: true },
    'ArrowUp': { scancode: 0x48, extended: true },
    'PageUp': { scancode: 0x49, extended: true },
    'ArrowLeft': { scancode: 0x4b, extended: true },
    'ArrowRight': { scancode: 0x4d, extended: true },
    'End': { scancode: 0x4f, extended: true },
    'ArrowDown': { scancode: 0x50, extended: true },
    'PageDown': { scancode: 0x51, extended: true },
    'Insert': { scancode: 0x52, extended: true },
    'Delete': { scancode: 0x53, extended: true },
    'MetaLeft': { scancode: 0x5b, extended: true },
    'MetaRight': { scancode: 0x5c, extended: true },
    'ContextMenu': { scancode: 0x5d, extended: true },
  };

  return CODE_MAP[code] || { scancode: 0x39, extended: false }; // Fallback to Space
}

/** Map mouse button names to button numbers (0=left, 1=middle, 2=right) */
function buttonToNumber(button: input.MouseButton): number {
  switch (button) {
    case 'left': return 0;
    case 'middle': return 1;
    case 'right': return 2;
  }
}

/**
 * RDP session manager — holds all active sessions.
 */
export class RdpSessionManager {
  private sessions = new Map<string, RdpSession>();

  /** Get a session by ID */
  get(sessionId: string): RdpSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Create and store a new session */
  create(sessionId: string, config: RdpEngineConfig): RdpSession {
    const session = new RdpSession(sessionId, config);
    this.sessions.set(sessionId, session);
    return session;
  }

  /** Remove a session */
  async remove(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.disconnect();
      this.sessions.delete(sessionId);
    }
  }

  /** List all session IDs */
  list(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Disconnect and remove all sessions */
  async closeAll(): Promise<void> {
    const ids = this.list();
    await Promise.all(ids.map((id) => this.remove(id)));
  }
}
