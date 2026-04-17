/** Type declarations for the Electron IPC bridge exposed via preload.ts */
declare global {
  interface Window {
    electron: {
      platform: NodeJS.Platform;
      invoke: (channel: string, args?: unknown) => Promise<unknown>;
      send: (channel: string, ...args: unknown[]) => void;
      on: (
        channel: string,
        callback: (...args: unknown[]) => void
      ) => () => void;
      removeListener: (
        channel: string,
        callback: (...args: unknown[]) => void
      ) => void;
    };
  }
}

export {};
