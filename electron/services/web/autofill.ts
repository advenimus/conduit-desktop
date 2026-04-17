/**
 * Autofill scripts for web sessions.
 *
 * These are JavaScript strings executed inside WebContentsView via
 * webContents.executeJavaScript(). They run in the context of the
 * loaded web page and return JSON results.
 */

import { UNIQUE_SELECTOR_FN } from './selector-utils.js';

export interface DiscoveryResult {
  usernameField: string | null;
  passwordField: string | null;
  submitButton: string | null;
  isMultiStep: boolean;
  error?: string;
}

export interface FillResult {
  fieldsFilled: string[];
  error?: string;
}

/**
 * Discovery script — finds login form fields on the current page.
 * Returns a DiscoveryResult as JSON.
 */
export function buildDiscoveryScript(): string {
  return `(function() {
    try {
    ${UNIQUE_SELECTOR_FN}

    var passwordInputs = document.querySelectorAll('input[type="password"]:not([hidden]):not([aria-hidden="true"])');
    var passwordField = null;
    var usernameField = null;
    var submitButton = null;
    var isMultiStep = false;

    // Filter to visible password fields
    var visiblePasswords = Array.from(passwordInputs).filter(function(el) {
      var rect = el.getBoundingClientRect();
      var style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });

    if (visiblePasswords.length > 0) {
      passwordField = _uniqueSelector(visiblePasswords[0]);

      // Find username: look in same form first, then page-wide
      var form = visiblePasswords[0].closest('form');
      var searchRoot = form || document;
      var candidates = searchRoot.querySelectorAll('input[type="text"], input[type="email"], input:not([type])');
      var usernameCandidates = Array.from(candidates).filter(function(el) {
        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        if (rect.width === 0 || rect.height === 0 || style.display === 'none' || style.visibility === 'hidden') return false;
        if (el.type === 'hidden' || el.type === 'password') return false;
        var id = (el.id || '').toLowerCase();
        var name = (el.name || '').toLowerCase();
        var placeholder = (el.placeholder || '').toLowerCase();
        var label = (el.getAttribute('aria-label') || '').toLowerCase();
        var pattern = /user|login|email|account|name|identifier/;
        return pattern.test(id) || pattern.test(name) || pattern.test(placeholder) || pattern.test(label) || el.type === 'email';
      });

      if (usernameCandidates.length > 0) {
        usernameField = _uniqueSelector(usernameCandidates[0]);
      } else {
        // Fallback: first text-like input before the password field
        var allInputs = Array.from(searchRoot.querySelectorAll('input'));
        var pwIdx = allInputs.indexOf(visiblePasswords[0]);
        for (var i = pwIdx - 1; i >= 0; i--) {
          var inp = allInputs[i];
          if ((inp.type === 'text' || inp.type === 'email' || !inp.type) && inp.getBoundingClientRect().height > 0) {
            usernameField = _uniqueSelector(inp);
            break;
          }
        }
      }
    } else {
      // No password field — could be step 1 of multi-step login
      isMultiStep = true;
      var textInputs = document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])');
      var usernameInputs = Array.from(textInputs).filter(function(el) {
        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        if (rect.width === 0 || rect.height === 0 || style.display === 'none' || style.visibility === 'hidden') return false;
        if (el.type === 'hidden' || el.type === 'password') return false;
        var id = (el.id || '').toLowerCase();
        var name = (el.name || '').toLowerCase();
        var placeholder = (el.placeholder || '').toLowerCase();
        var label = (el.getAttribute('aria-label') || '').toLowerCase();
        var pattern = /user|login|email|account|name|identifier/;
        return pattern.test(id) || pattern.test(name) || pattern.test(placeholder) || pattern.test(label) || el.type === 'email';
      });
      if (usernameInputs.length > 0) {
        usernameField = _uniqueSelector(usernameInputs[0]);
      }
    }

    // Find submit button
    var form2 = (passwordField || usernameField)
      ? (document.querySelector(passwordField || usernameField) || {}).closest && document.querySelector(passwordField || usernameField).closest('form')
      : null;
    var searchRoot2 = form2 || document;

    var submitCandidates = Array.from(searchRoot2.querySelectorAll(
      'button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"])'
    )).filter(function(el) {
      var rect = el.getBoundingClientRect();
      var style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });

    if (submitCandidates.length > 0) {
      submitButton = _uniqueSelector(submitCandidates[0]);
    } else {
      // Look for buttons with sign-in text
      var allButtons = Array.from(searchRoot2.querySelectorAll('button, a[role="button"], div[role="button"]'));
      var signInPattern = /sign.?in|log.?in|next|continue|submit/i;
      for (var j = 0; j < allButtons.length; j++) {
        var btn = allButtons[j];
        var btnText = (btn.textContent || '').trim();
        var btnLabel = btn.getAttribute('aria-label') || '';
        var btnTitle = btn.getAttribute('title') || '';
        if (signInPattern.test(btnText) || signInPattern.test(btnLabel) || signInPattern.test(btnTitle)) {
          var bRect = btn.getBoundingClientRect();
          if (bRect.width > 0 && bRect.height > 0) {
            submitButton = _uniqueSelector(btn);
            break;
          }
        }
      }
    }

    return JSON.stringify({
      usernameField: usernameField,
      passwordField: passwordField,
      submitButton: submitButton,
      isMultiStep: isMultiStep
    });
    } catch (err) {
      return JSON.stringify({ usernameField: null, passwordField: null, submitButton: null, isMultiStep: false, error: String(err) });
    }
  })()`;
}

/**
 * Build a script that fills form fields using native value setter
 * to bypass React/Angular/Vue controlled input handling.
 */
export function buildFillScript(
  usernameSelector: string | null,
  passwordSelector: string | null,
  username: string | null,
  password: string | null
): string {
  // Safely encode credentials into the script
  const creds = JSON.stringify({ username, password, usernameSelector, passwordSelector });

  return `(function() {
    try {
    var creds = ${creds};
    var filled = [];
    var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    var nativeSetter = descriptor && descriptor.set;

    function fillField(selector, value) {
      if (!selector || !value) return false;
      var el = document.querySelector(selector);
      if (!el) return false;
      el.focus();
      if (nativeSetter) {
        nativeSetter.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    }

    if (fillField(creds.usernameSelector, creds.username)) filled.push('username');
    if (fillField(creds.passwordSelector, creds.password)) filled.push('password');

    return JSON.stringify({ fieldsFilled: filled });
    } catch (err) {
      return JSON.stringify({ fieldsFilled: [], error: String(err) });
    }
  })()`;
}

/**
 * Build a script that clicks an element by CSS selector.
 */
export function buildClickScript(selector: string): string {
  const escaped = JSON.stringify(selector);
  return `(function() {
    try {
      var el = document.querySelector(${escaped});
      if (el) { el.click(); return true; }
      return false;
    } catch (err) {
      return false;
    }
  })()`;
}
