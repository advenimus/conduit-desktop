/**
 * Web tab state tracking.
 *
 * A WebTab represents a single page/view within a web session.
 * Each session can have multiple tabs (sub-tabs), similar to
 * a browser's tab model within a single Conduit session.
 */

import { WebContentsView } from 'electron';

export interface WebTabInfo {
  id: string;
  url: string;
  title: string | null;
  favicon: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isSecure: boolean;
}

export class WebTab {
  readonly id: string;
  url: string;
  title: string | null = null;
  favicon: string | null = null;
  isLoading = false;
  canGoBack = false;
  canGoForward = false;

  /** The Electron WebContentsView, created when the tab is initialized */
  view: WebContentsView | null = null;

  /** Stored bounds for hide/show restore */
  bounds: { x: number; y: number; width: number; height: number } | null = null;

  /** Set to true after user clicks "Proceed Anyway" on a cert warning */
  certAccepted = false;

  /** Whether a cert error notification has already been sent for this tab */
  certErrorNotified = false;

  /** Whether auto-autofill has already been triggered for this tab */
  autoAutofilled = false;

  /** Whether the selector picker is currently active in this tab */
  pickerActive = false;

  constructor(id: string, url: string) {
    this.id = id;
    this.url = url;
  }

  toInfo(): WebTabInfo {
    return {
      id: this.id,
      url: this.url,
      title: this.title,
      favicon: this.favicon,
      isLoading: this.isLoading,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      isSecure: this.url.startsWith('https://') || this.url.startsWith('https:'),
    };
  }
}
