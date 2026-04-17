/**
 * Web session state tracking.
 *
 * A WebSession is a container for one or more WebTabs.
 * It holds session-level config (user agent, cert errors, entry ID)
 * while per-tab state (view, URL, title, etc.) lives in WebTab.
 */

import { WebTab } from './tab.js';

export type SessionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WebSessionInfo {
  id: string;
  url: string;
  title: string | null;
  state: SessionState;
  entryId: string | null;
}

export class WebSession {
  readonly id: string;

  /** The original URL this session was opened with (used for "Home" button) */
  readonly originalUrl: string;

  state: SessionState = 'disconnected';
  userAgent: string | null;
  ignoreCertErrors: boolean;

  /** Entry ID this session was opened from (for auto-autofill) */
  entryId: string | null;

  /** Resolved engine type for this session */
  engine: 'chromium' | 'webview2' = 'chromium';

  /** Sub-tabs within this session */
  tabs: WebTab[] = [];

  /** Currently active tab ID */
  activeTabId: string | null = null;

  constructor(id: string, url: string, userAgent?: string, ignoreCertErrors?: boolean, entryId?: string, engine?: 'chromium' | 'webview2') {
    this.id = id;
    this.originalUrl = url;
    this.userAgent = userAgent ?? null;
    this.ignoreCertErrors = ignoreCertErrors ?? false;
    this.entryId = entryId ?? null;
    this.engine = engine ?? 'chromium';
  }

  /** Get the currently active tab, or null if none. */
  getActiveTab(): WebTab | null {
    if (!this.activeTabId) return null;
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
  }

  /** Add a tab and optionally activate it. */
  addTab(tab: WebTab, activate = true): void {
    this.tabs.push(tab);
    if (activate) {
      this.activeTabId = tab.id;
    }
  }

  /** Remove a tab by ID. Returns the removed tab, or null. */
  removeTab(tabId: string): WebTab | null {
    const index = this.tabs.findIndex((t) => t.id === tabId);
    if (index === -1) return null;
    const [removed] = this.tabs.splice(index, 1);

    // If we removed the active tab, activate an adjacent one
    if (this.activeTabId === tabId) {
      if (this.tabs.length > 0) {
        const newIndex = Math.min(index, this.tabs.length - 1);
        this.activeTabId = this.tabs[newIndex].id;
      } else {
        this.activeTabId = null;
      }
    }

    return removed;
  }

  /** Get a tab by ID. */
  getTab(tabId: string): WebTab | null {
    return this.tabs.find((t) => t.id === tabId) ?? null;
  }

  /** Reorder a tab from one index to another. */
  reorderTab(fromIndex: number, toIndex: number): void {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= this.tabs.length) return;
    if (toIndex < 0 || toIndex >= this.tabs.length) return;
    const [moved] = this.tabs.splice(fromIndex, 1);
    this.tabs.splice(toIndex, 0, moved);
  }

  /** Convenience: get the URL of the active tab, or the original URL. */
  get url(): string {
    const tab = this.getActiveTab();
    return tab?.url ?? this.originalUrl;
  }

  /** Convenience: get the title of the active tab. */
  get title(): string | null {
    return this.getActiveTab()?.title ?? null;
  }

  toInfo(): WebSessionInfo {
    return {
      id: this.id,
      url: this.url,
      title: this.title,
      state: this.state,
      entryId: this.entryId,
    };
  }
}
