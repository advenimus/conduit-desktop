/**
 * Autofill orchestration for web sessions.
 *
 * Standalone functions extracted from WebSessionManager.
 * Handles both WebView2 (via pipe) and Chromium (via WebContentsView) paths.
 */

import type { WebContentsView } from 'electron';
import type { WebView2Session } from './webview2-session.js';
import type { WebTab } from './tab.js';
import {
  buildDiscoveryScript,
  buildFillScript,
  buildClickScript,
  type DiscoveryResult,
  type FillResult,
} from './autofill.js';
import {
  buildSelectorPickerScript,
  buildCancelPickerScript,
  type PickerResult,
} from './picker.js';

/** Helper to safely parse JSON that may already be an object (WebView2 auto-unwrap). */
function safeParse<T>(raw: unknown): T {
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
}

// ──────────────────────────────────────────────────────────────
//  Discover fields
// ──────────────────────────────────────────────────────────────

export async function discoverFields(
  wv2: WebView2Session | undefined,
  tab: WebTab | undefined,
  sessionId: string,
): Promise<DiscoveryResult> {
  if (wv2) {
    console.log(`[autofill] discoverFields (wv2) session=${sessionId.slice(0, 8)}`);
    const raw = await wv2.executeScript(buildDiscoveryScript());
    return safeParse<DiscoveryResult>(raw);
  }

  if (!tab?.view) throw new Error(`No webview for session ${sessionId}`);
  console.log(`[autofill] discoverFields session=${sessionId.slice(0, 8)} url=${tab.url}`);
  const raw = await tab.view.webContents.executeJavaScript(buildDiscoveryScript());
  const result = JSON.parse(raw) as DiscoveryResult;
  if (result.error) {
    console.error(`[autofill] discovery script error: ${result.error}`);
  } else {
    console.log(`[autofill] discovery result: username=${result.usernameField ?? 'none'}, password=${result.passwordField ? 'found' : 'none'}, submit=${result.submitButton ? 'found' : 'none'}, multiStep=${result.isMultiStep}`);
  }
  return result;
}

// ──────────────────────────────────────────────────────────────
//  Fill fields
// ──────────────────────────────────────────────────────────────

export async function fillFields(
  wv2: WebView2Session | undefined,
  tab: WebTab | undefined,
  sessionId: string,
  username: string | null,
  password: string | null,
  userSelector: string | null,
  pwSelector: string | null,
): Promise<FillResult> {
  if (wv2) {
    console.log(`[autofill] fillFields (wv2) session=${sessionId.slice(0, 8)}`);
    const raw = await wv2.executeScript(
      buildFillScript(userSelector, pwSelector, username, password),
    );
    return safeParse<FillResult>(raw);
  }

  if (!tab?.view) throw new Error(`No webview for session ${sessionId}`);
  console.log(`[autofill] fillFields session=${sessionId.slice(0, 8)} userSelector=${userSelector ?? 'none'} pwSelector=${pwSelector ? 'set' : 'none'}`);
  const raw = await tab.view.webContents.executeJavaScript(
    buildFillScript(userSelector, pwSelector, username, password),
  );
  const result = JSON.parse(raw) as FillResult;
  if (result.error) {
    console.error(`[autofill] fill script error: ${result.error}`);
  } else {
    console.log(`[autofill] fill result: fieldsFilled=${JSON.stringify(result.fieldsFilled)}`);
  }
  return result;
}

// ──────────────────────────────────────────────────────────────
//  Click element by selector
// ──────────────────────────────────────────────────────────────

export async function clickElement(
  wv2: WebView2Session | undefined,
  tab: WebTab | undefined,
  sessionId: string,
  selector: string,
): Promise<boolean> {
  if (wv2) {
    const result = await wv2.executeScript(
      `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(el){el.click();return true}return false})()`,
    );
    return result as boolean;
  }

  if (!tab?.view) throw new Error(`No webview for session ${sessionId}`);
  console.log(`[autofill] clickElement session=${sessionId.slice(0, 8)} selector=${selector}`);
  const clicked = await tab.view.webContents.executeJavaScript(buildClickScript(selector));
  console.log(`[autofill] clickElement result: ${clicked}`);
  return clicked;
}

// ──────────────────────────────────────────────────────────────
//  Wait for page change
// ──────────────────────────────────────────────────────────────

export function waitForPageChange(
  wv2: WebView2Session | undefined,
  tab: WebTab | undefined,
  sessionId: string,
  timeoutMs = 5000,
): Promise<void> {
  if (wv2) {
    console.log(`[autofill] waitForPageChange (wv2) session=${sessionId.slice(0, 8)} timeout=${timeoutMs}ms`);
    return new Promise<void>((resolve) => {
      const mutationScript = `(function(){return new Promise(function(resolve){var observer=new MutationObserver(function(mutations){var significant=mutations.some(function(m){return m.addedNodes.length>2||m.removedNodes.length>2});if(significant){observer.disconnect();resolve(true)}});observer.observe(document.body,{childList:true,subtree:true});setTimeout(function(){observer.disconnect();resolve(false)},${timeoutMs})})})()`;
      const timer = setTimeout(() => resolve(), timeoutMs);
      wv2.executeScript(mutationScript)
        .then(() => { clearTimeout(timer); resolve(); })
        .catch(() => { clearTimeout(timer); resolve(); });
    });
  }

  const view = tab?.view;
  if (!view) return Promise.reject(new Error(`No webview for session ${sessionId}`));

  console.log(`[autofill] waitForPageChange session=${sessionId.slice(0, 8)} timeout=${timeoutMs}ms`);
  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = (trigger: string) => {
      if (resolved) return;
      resolved = true;
      console.log(`[autofill] waitForPageChange resolved via: ${trigger}`);
      view.webContents.removeListener('did-navigate', onNav);
      view.webContents.removeListener('did-navigate-in-page', onNav);
      clearTimeout(timer);
      resolve();
    };

    const onNav = () => done('navigation');
    view.webContents.on('did-navigate', onNav);
    view.webContents.on('did-navigate-in-page', onNav);

    // Also detect SPA mutations via injected MutationObserver
    view.webContents.executeJavaScript(`
      new Promise(function(resolve) {
        var observer = new MutationObserver(function(mutations) {
          var significant = mutations.some(function(m) {
            return m.addedNodes.length > 2 || m.removedNodes.length > 2;
          });
          if (significant) { observer.disconnect(); resolve(true); }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(function() { observer.disconnect(); resolve(false); }, ${timeoutMs});
      })
    `).then((mutated) => done(mutated ? 'mutation' : 'mutation-timeout')).catch(() => done('mutation-error'));

    const timer = setTimeout(() => done('timeout'), timeoutMs);
  });
}

// ──────────────────────────────────────────────────────────────
//  Full autofill orchestration
// ──────────────────────────────────────────────────────────────

export interface AutofillResult {
  success: boolean;
  phase: string;
  fieldsFilled: string[];
  error?: string;
}

export async function executeAutofill(
  wv2: WebView2Session | undefined,
  tab: WebTab | undefined,
  sessionId: string,
  username: string | null,
  password: string | null,
  config: {
    usernameSelector?: string;
    passwordSelector?: string;
    submitSelector?: string;
    multiStepLogin?: boolean;
  },
): Promise<AutofillResult> {
  try {
    console.log(`[autofill] executeAutofill session=${sessionId.slice(0, 8)} config=${JSON.stringify({ usernameSelector: config.usernameSelector, passwordSelector: config.passwordSelector, submitSelector: config.submitSelector, multiStepLogin: config.multiStepLogin })}`);

    // Phase 1: Discover fields
    const discovery = await discoverFields(wv2, tab, sessionId);

    if (discovery.error) {
      console.error(`[autofill] aborting — discovery script error: ${discovery.error}`);
      return { success: false, phase: 'discover', fieldsFilled: [], error: `Discovery script error: ${discovery.error}` };
    }

    const userSel = config.usernameSelector || discovery.usernameField;
    const pwSel = config.passwordSelector || discovery.passwordField;
    const submitSel = config.submitSelector || discovery.submitButton;

    const isMultiStep = config.multiStepLogin && (discovery.isMultiStep || !pwSel);
    console.log(`[autofill] resolved selectors: user=${userSel ?? 'none'}, pw=${pwSel ? 'set' : 'none'}, submit=${submitSel ? 'set' : 'none'}, isMultiStep=${isMultiStep}`);

    if (isMultiStep) {
      if (!userSel) {
        return { success: false, phase: 'discover', fieldsFilled: [], error: 'Could not find username field' };
      }

      const fill1 = await fillFields(wv2, tab, sessionId, username, null, userSel, null);
      if (fill1.fieldsFilled.length === 0) {
        return { success: false, phase: 'fill_username', fieldsFilled: [], error: 'Failed to fill username field' };
      }

      if (submitSel) {
        await clickElement(wv2, tab, sessionId, submitSel);
      }

      await waitForPageChange(wv2, tab, sessionId);
      await new Promise((r) => setTimeout(r, 500));

      // Phase 2: Re-discover for password field
      const discovery2 = await discoverFields(wv2, tab, sessionId);
      const pwSel2 = config.passwordSelector || discovery2.passwordField;

      if (!pwSel2) {
        return { success: false, phase: 'discover_password', fieldsFilled: fill1.fieldsFilled, error: 'Could not find password field on second page' };
      }

      const fill2 = await fillFields(wv2, tab, sessionId, null, password, null, pwSel2);
      return {
        success: true,
        phase: 'complete_multistep',
        fieldsFilled: [...fill1.fieldsFilled, ...fill2.fieldsFilled],
      };
    } else {
      if (!userSel && !pwSel) {
        return { success: false, phase: 'discover', fieldsFilled: [], error: 'Could not find any login fields on this page' };
      }

      const fill = await fillFields(wv2, tab, sessionId, username, password, userSel, pwSel);
      return {
        success: fill.fieldsFilled.length > 0,
        phase: 'complete',
        fieldsFilled: fill.fieldsFilled,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[autofill] executeAutofill failed with exception: ${message}`);
    return { success: false, phase: 'error', fieldsFilled: [], error: message };
  }
}

// ──────────────────────────────────────────────────────────────
//  Selector picker
// ──────────────────────────────────────────────────────────────

export async function startSelectorPicker(
  wv2: WebView2Session | undefined,
  tab: WebTab | undefined,
  sessionId: string,
  cancelCallback: () => void,
): Promise<PickerResult | null> {
  // WebView2: ExecuteScriptAsync doesn't properly return long-running
  // Promise results. Inject the picker, store its result in a global, and poll.
  if (wv2) {
    try {
      const setupScript = `(function(){
        window.__conduitPickerResult = null;
        var p = ${buildSelectorPickerScript()};
        p.then(function(r){ window.__conduitPickerResult = r; });
        return 'setup_ok';
      })()`;
      await wv2.executeScript(setupScript);

      const pollScript = `(function(){
        var r = window.__conduitPickerResult;
        if (r != null) { window.__conduitPickerResult = null; return r; }
        return null;
      })()`;
      const maxWaitMs = 120_000;
      const pollIntervalMs = 300;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        if (wv2.closed) return null;
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        const raw = await wv2.executeScript(pollScript);
        if (raw != null) {
          const result = safeParse<PickerResult>(raw);
          if (result.cancelled) return null;
          return result;
        }
      }

      // Timeout — cancel picker
      await wv2.executeScript(buildCancelPickerScript());
      return null;
    } catch (err) {
      console.warn(`[picker] wv2 executeScript failed for session ${sessionId.slice(0, 8)}:`, err);
      return null;
    }
  }

  if (!tab?.view || tab.view.webContents.isDestroyed()) return null;

  tab.pickerActive = true;

  const onNavigate = () => cancelCallback();
  tab.view.webContents.once('did-navigate', onNavigate);

  try {
    const raw = await tab.view.webContents.executeJavaScript(buildSelectorPickerScript());
    const result = JSON.parse(raw) as PickerResult;
    if (result.cancelled) return null;
    return result;
  } catch (err) {
    console.warn(`[picker] executeJavaScript failed for session ${sessionId.slice(0, 8)}:`, err);
    return null;
  } finally {
    tab.pickerActive = false;
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.removeListener('did-navigate', onNavigate);
    }
  }
}

export async function cancelSelectorPicker(
  wv2: WebView2Session | undefined,
  tab: WebTab | undefined,
): Promise<void> {
  if (wv2) {
    try { await wv2.executeScript(buildCancelPickerScript()); } catch { /* ignore */ }
    return;
  }

  if (!tab?.pickerActive) return;
  if (!tab.view || tab.view.webContents.isDestroyed()) return;

  try {
    await tab.view.webContents.executeJavaScript(buildCancelPickerScript());
  } catch {
    // Webview may have been destroyed — safe to ignore
  }
}
