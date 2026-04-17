declare module '@novnc/novnc/lib/rfb.js' {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | object,
      options?: {
        credentials?: Record<string, string>;
        shared?: boolean;
        repeaterID?: string;
        wsProtocols?: string[];
      }
    );

    // Properties
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    background: string;
    compressionLevel: number;
    qualityLevel: number;

    // Internal state (accessed for MCP actions)
    _fbWidth: number;
    _fbHeight: number;
    _fbName: string;
    _canvas: HTMLCanvasElement;
    _rfbConnectionState: string;

    // Methods
    disconnect(): void;
    sendCredentials(credentials: Record<string, string>): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;
  }
}
