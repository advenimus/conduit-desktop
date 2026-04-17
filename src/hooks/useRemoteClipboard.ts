/**
 * useRemoteClipboard — bidirectional clipboard sync for RDP/VNC sessions.
 *
 * Syncs the local system clipboard to the remote desktop on:
 *   - Container focus (so Ctrl+V in remote has current local content)
 *   - Tab activation (isActive becomes true)
 *   - Paste event (safety net for explicit paste actions)
 *
 * Listens for clipboard events from main process (informational —
 * main process already writes to system clipboard).
 */

import { useEffect, useRef, type RefObject } from "react";
import { invoke, listenSync, type UnlistenFn } from "../lib/electron";
import { toast } from "../components/common/Toast";

export interface ClipboardFileInfo {
  name: string;
  size: number;
  isDir: boolean;
}

export interface ClipboardFileProgress {
  fileIndex: number;
  bytesTransferred: number;
  totalSize: number;
  totalFiles: number;
  direction: "download" | "upload";
  fileNames?: string[];
  fileTotalSize?: number;
}

interface UseRemoteClipboardOptions {
  sessionId: string;
  protocol: "rdp" | "vnc";
  isConnected: boolean;
  isActive: boolean;
  enabled: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onRemoteFilesAvailable?: (files: ClipboardFileInfo[]) => void;
  onRemoteFilesComplete?: (filePaths: string[]) => void;
  onFileProgress?: (progress: ClipboardFileProgress) => void;
}

export function useRemoteClipboard({
  sessionId,
  protocol,
  isConnected,
  isActive,
  enabled,
  containerRef,
  onRemoteFilesAvailable,
  onRemoteFilesComplete,
  onFileProgress,
}: UseRemoteClipboardOptions): void {
  const lastSyncRef = useRef<number>(0);

  // Sync local clipboard to remote — debounced to avoid spamming
  const syncToRemote = (trigger: string) => {
    if (!enabled || !isConnected) return;
    const now = Date.now();
    if (now - lastSyncRef.current < 500) return; // 500ms debounce
    lastSyncRef.current = now;
    invoke(`${protocol}_clipboard_sync`, { sessionId }).catch((err) => {
      console.error(`[Clipboard] ${protocol}_clipboard_sync(${trigger}) failed:`, err);
    });
  };

  // On focus of container: sync local clipboard to remote
  useEffect(() => {
    if (!enabled || !isConnected) return;
    const el = containerRef.current;
    if (!el) return;

    const handleFocus = () => syncToRemote("focus");
    el.addEventListener("focus", handleFocus);
    return () => el.removeEventListener("focus", handleFocus);
  }, [sessionId, protocol, isConnected, enabled, containerRef]);

  // On paste event: send clipboard text directly as safety net
  useEffect(() => {
    if (!enabled || !isConnected) return;
    const el = containerRef.current;
    if (!el) return;

    const handlePaste = (e: Event) => {
      const clipboardEvent = e as ClipboardEvent;
      const text = clipboardEvent.clipboardData?.getData("text/plain");
      if (text) {
        invoke(`${protocol}_clipboard_send`, { sessionId, text }).catch(() => {});
      }
    };

    el.addEventListener("paste", handlePaste);
    return () => el.removeEventListener("paste", handlePaste);
  }, [sessionId, protocol, isConnected, enabled, containerRef]);

  // On isActive change to true: sync clipboard
  useEffect(() => {
    if (isActive && enabled && isConnected) {
      syncToRemote("isActive");
    }
  }, [isActive, enabled, isConnected]);

  // Listen for clipboard events from main process (informational)
  useEffect(() => {
    if (!enabled || !isConnected) return;

    const unlisten = listenSync<{ sessionId: string; text: string }>(
      `${protocol}:clipboard`,
      (event) => {
        if (event.payload.sessionId === sessionId) {
          toast.success("Copied from remote clipboard");
        }
      }
    );

    return () => unlisten();
  }, [sessionId, protocol, isConnected, enabled]);

  // Listen for file clipboard events (remote files available)
  // Uses listenSync to avoid async cleanup race — unlisten fns are available immediately.
  useEffect(() => {
    if (!enabled || !isConnected || protocol !== "rdp") return;

    const unlistens: UnlistenFn[] = [];

    unlistens.push(listenSync<{ sessionId: string; files: ClipboardFileInfo[] }>(
      "rdp:clipboard-files-available",
      (event) => {
        if (event.payload.sessionId === sessionId && onRemoteFilesAvailable) {
          onRemoteFilesAvailable(event.payload.files);
        }
      }
    ));

    unlistens.push(listenSync<{ sessionId: string; files: string[] }>(
      "rdp:clipboard-files-complete",
      (event) => {
        if (event.payload.sessionId === sessionId && onRemoteFilesComplete) {
          onRemoteFilesComplete(event.payload.files);
        }
      }
    ));

    unlistens.push(listenSync<{ sessionId: string } & ClipboardFileProgress>(
      "rdp:clipboard-file-progress",
      (event) => {
        if (event.payload.sessionId === sessionId && onFileProgress) {
          onFileProgress(event.payload);
        }
      }
    ));

    return () => {
      for (const fn of unlistens) fn();
    };
  }, [sessionId, protocol, isConnected, enabled, onRemoteFilesAvailable, onRemoteFilesComplete, onFileProgress]);
}
