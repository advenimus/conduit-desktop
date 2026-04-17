/**
 * Unified tool approval service for MCP tool calls.
 *
 * Every MCP tool call (from built-in chat or external MCP clients) is routed
 * through this service before execution. Tools in the "always allowed" set
 * skip the UI prompt; all others require explicit user approval via a dialog
 * in the renderer process.
 */

import { randomUUID } from 'node:crypto';
import { readSettings, writeSettings } from '../ipc/settings.js';
import { AppState } from './state.js';
import type { ToolCategory } from './ai/tool-registry.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToolApprovalDecision {
  approved: boolean;
  alwaysAllow: boolean;
}

interface PendingRequest {
  resolve: (decision: ToolApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Sensitive arg keys whose values are masked before sending to renderer. */
const SENSITIVE_ARG_KEYS = new Set([
  'password', 'private_key', 'totp_secret',
]);

// ── Service ──────────────────────────────────────────────────────────────────

export class ToolApprovalService {
  private pending = new Map<string, PendingRequest>();
  private alwaysAllowed: Set<string>;
  private enabled: boolean;

  constructor() {
    // Load persisted settings once at init — updated via setEnabled()
    const settings = readSettings();
    this.alwaysAllowed = new Set(settings.tool_approval_always_allow ?? []);
    this.enabled = settings.tool_approval_enabled ?? true;
  }

  // ── Fast path ────────────────────────────────────────────────────────────

  /** Check if approval is globally disabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Update the enabled flag (called from IPC handler). Persists to settings. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    const settings = readSettings();
    writeSettings({ ...settings, tool_approval_enabled: enabled });
  }

  isAlwaysAllowed(toolName: string): boolean {
    return this.alwaysAllowed.has(toolName);
  }

  addAlwaysAllowed(toolName: string): void {
    this.alwaysAllowed.add(toolName);
    this.persistAlwaysAllowed();
  }

  removeAlwaysAllowed(toolName: string): void {
    this.alwaysAllowed.delete(toolName);
    this.persistAlwaysAllowed();
  }

  getAllAlwaysAllowed(): string[] {
    return Array.from(this.alwaysAllowed);
  }

  clearAlwaysAllowed(): void {
    this.alwaysAllowed.clear();
    this.persistAlwaysAllowed();
  }

  // ── Approval request ─────────────────────────────────────────────────────

  /**
   * Request approval for a tool call.
   *
   * Returns `{ approved: true }` immediately if the tool is always-allowed
   * or if approval is disabled. Otherwise shows a dialog and waits for user
   * response (120s timeout → auto-deny).
   */
  async requestApproval(
    toolName: string,
    description: string,
    category: ToolCategory,
    args: Record<string, unknown>,
  ): Promise<{ approved: boolean }> {
    // Bypass: approval disabled globally
    if (!this.isEnabled()) {
      return { approved: true };
    }

    // Fast path: tool is always-allowed
    if (this.alwaysAllowed.has(toolName)) {
      return { approved: true };
    }

    // Mask sensitive arg values before sending to renderer
    const maskedArgs = this.maskSensitiveArgs(args);

    const requestId = randomUUID();

    // Create promise that resolves when the user responds or timeout fires
    const decision = await new Promise<ToolApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        // Auto-deny on timeout
        this.pending.delete(requestId);
        resolve({ approved: false, alwaysAllow: false });

        // Notify renderer to remove the stale card
        const win = AppState.getInstance().getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('mcp:tool_approval_expired', { request_id: requestId });
        }
      }, 120_000);

      this.pending.set(requestId, { resolve, timer });

      // Emit to renderer
      const mainWindow = AppState.getInstance().getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mcp:tool_approval_request', {
          request_id: requestId,
          tool_name: toolName,
          description,
          category,
          args: maskedArgs,
        });
      } else {
        // No window to show dialog — auto-deny
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ approved: false, alwaysAllow: false });
      }
    });

    // If user chose "always allow" and approved, persist
    if (decision.approved && decision.alwaysAllow) {
      this.addAlwaysAllowed(toolName);
    }

    return { approved: decision.approved };
  }

  /**
   * Called by the IPC handler when the user responds to an approval dialog.
   * Returns false if the requestId is not found (already resolved or timed out).
   */
  resolve(requestId: string, decision: ToolApprovalDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(decision);
    return true;
  }

  /**
   * Deny all currently pending approval requests.
   * Called when the AI agent is cancelled (Stop button) so blocked tool calls
   * unblock immediately instead of waiting for the 120s timeout.
   */
  denyAllPending(): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ approved: false, alwaysAllow: false });
    }
    this.pending.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private persistAlwaysAllowed(): void {
    const settings = readSettings();
    const updated = {
      ...settings,
      tool_approval_always_allow: Array.from(this.alwaysAllowed),
    };
    writeSettings(updated);
  }

  private maskSensitiveArgs(args: Record<string, unknown>): Record<string, unknown> {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (SENSITIVE_ARG_KEYS.has(key) && typeof value === 'string') {
        masked[key] = '********';
      } else {
        masked[key] = value;
      }
    }
    return masked;
  }
}
