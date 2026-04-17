/**
 * Selector picker scripts for web sessions.
 *
 * Injected into WebContentsView pages to let users visually click on
 * elements and capture CSS selectors for autofill configuration.
 */

import { UNIQUE_SELECTOR_FN } from './selector-utils.js';

export interface PickerResult {
  selector: string;
  tagName: string;
  type: string | null;
  name: string | null;
  placeholder: string | null;
  id: string | null;
  cancelled?: boolean;
}

/**
 * Build a script that highlights elements on hover and captures clicks.
 * Returns an IIFE wrapping a Promise that resolves with a JSON PickerResult.
 */
export function buildSelectorPickerScript(): string {
  return `(function() {
    ${UNIQUE_SELECTOR_FN}

    return new Promise(function(resolve) {
      // Prevent duplicate pickers
      if (window.__conduitPickerActive) {
        resolve(JSON.stringify({ cancelled: true }));
        return;
      }
      window.__conduitPickerActive = true;

      // Create highlight overlay
      var overlay = document.createElement('div');
      overlay.id = '__conduit-picker-overlay';
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);border-radius:3px;transition:all 0.05s ease;display:none;';

      // Label showing tag name
      var label = document.createElement('div');
      label.style.cssText = 'position:absolute;top:-20px;left:0;background:#3b82f6;color:white;font-size:11px;padding:1px 6px;border-radius:2px;font-family:monospace;white-space:nowrap;pointer-events:none;';
      overlay.appendChild(label);
      document.body.appendChild(overlay);

      var currentTarget = null;

      function cleanup() {
        document.removeEventListener('mouseover', onMouseOver, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeyDown, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        window.__conduitPickerActive = false;
        window.__conduitPickerResolve = null;
      }

      function onMouseOver(e) {
        var el = e.target;
        if (el === overlay || overlay.contains(el)) return;
        currentTarget = el;
        var rect = el.getBoundingClientRect();
        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        overlay.style.display = 'block';
        var tag = el.tagName.toLowerCase();
        if (el.type) tag += '[type=' + el.type + ']';
        else if (el.id) tag += '#' + el.id;
        label.textContent = tag;
      }

      function onClick(e) {
        e.preventDefault();
        e.stopImmediatePropagation();
        var el = e.target;
        if (el === overlay || overlay.contains(el)) return;
        var selector = _uniqueSelector(el);
        var result = {
          selector: selector,
          tagName: el.tagName.toLowerCase(),
          type: el.type || null,
          name: el.name || null,
          placeholder: el.placeholder || null,
          id: el.id || null
        };
        cleanup();
        resolve(JSON.stringify(result));
      }

      function onKeyDown(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          cleanup();
          resolve(JSON.stringify({ cancelled: true }));
        }
      }

      // Allow external cancellation from cancelSelectorPicker
      window.__conduitPickerResolve = function(val) {
        cleanup();
        resolve(val);
      };

      document.addEventListener('mouseover', onMouseOver, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeyDown, true);
    });
  })()`;
}

/**
 * Build a script that cancels an active picker by resolving its Promise.
 */
export function buildCancelPickerScript(): string {
  return `(function() {
    if (window.__conduitPickerResolve) {
      window.__conduitPickerResolve(JSON.stringify({ cancelled: true }));
      return true;
    }
    return false;
  })()`;
}
