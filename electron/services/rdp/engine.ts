/**
 * RDP Engine interface — abstraction layer for the FreeRDP backend.
 */

export interface SharedFolder {
  name: string;
  path: string;
  readOnly?: boolean;
}

export interface RdpEngineConfig {
  host: string;
  hostname?: string;
  port: number;
  username: string;
  password: string;
  domain?: string;
  width: number;
  height: number;
  enableNla: boolean;
  skipCertVerification: boolean;
  sharedFolders?: SharedFolder[];
  colorDepth?: 32 | 24 | 16 | 15;
  performanceMode?: 'best' | 'balanced' | 'fast';
  enableBitmapCache?: boolean;
  enableServerPointer?: boolean;
  frameRate?: 30 | 60;
  desktopScaleFactor?: number;
  deviceScaleFactor?: number;
  enableClipboard?: boolean;
}

export interface RdpBitmapUpdate {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Buffer;
}

export interface DesktopDimensions {
  width: number;
  height: number;
}

export type OnBitmapCallback = (update: RdpBitmapUpdate) => void;
export type OnCloseCallback = (error: string | null) => void;
export type OnResizeCallback = (dims: DesktopDimensions) => void;
export type OnClipboardCallback = (text: string) => void;

export interface ClipboardFileInfo {
  name: string;
  size: number;
  isDir: boolean;
}

export interface ClipboardFileDownloaded {
  fileIndex: number;
  name: string;
  size: number;
  tempPath: string;
}

export type OnClipboardFilesCallback = (files: ClipboardFileInfo[]) => void;
export type OnClipboardFileDoneCallback = (file: ClipboardFileDownloaded) => void;
export type OnClipboardFileErrorCallback = (fileIndex: number, error: string) => void;

export interface ClipboardFileProgress {
  fileIndex: number;
  bytesTransferred: number;
  totalSize: number;
  totalFiles: number;
  direction: 'download' | 'upload';
}

export type OnClipboardFileProgressCallback = (progress: ClipboardFileProgress) => void;

export interface CursorUpdate {
  hotspotX: number;
  hotspotY: number;
  width: number;
  height: number;
  data: Buffer;  // RGBA
}

export type OnCursorCallback = (cursor: CursorUpdate) => void;
export type OnCursorNullCallback = () => void;
export type OnCursorDefaultCallback = () => void;

/**
 * RDP engine interface — implemented by the FreeRDP backend.
 *
 * All input methods are synchronous (fire-and-forget).
 * connect() and close() are async.
 */
export interface RdpEngine {
  readonly connected: boolean;
  readonly nativeClipboardActive?: boolean;

  connect(
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
  ): Promise<DesktopDimensions>;

  mouseMove(x: number, y: number): void;
  mouseButtonDown(x: number, y: number, button: number): void;
  mouseButtonUp(x: number, y: number, button: number): void;
  mouseScroll(x: number, y: number, delta: number, vertical: boolean): void;

  keyDown(scancode: number, extended: boolean): void;
  keyUp(scancode: number, extended: boolean): void;

  getFrame(): Promise<Buffer>;
  getDimensions(): Promise<DesktopDimensions>;
  resize(width: number, height: number, desktopScaleFactor?: number, deviceScaleFactor?: number): Promise<void>;
  sendClipboard(text: string): void;
  sendClipboardFiles(files: { path: string; name: string; size: number; isDirectory: boolean }[]): void;
  requestClipboardFiles(tempDir: string): void;
  close(): Promise<void>;
}
