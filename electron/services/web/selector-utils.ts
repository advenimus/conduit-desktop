/**
 * Shared CSS selector utility used by autofill and picker scripts.
 *
 * This is a JavaScript string snippet injected into WebContentsView pages
 * via executeJavaScript(). It defines _uniqueSelector(el) which builds a
 * deterministic CSS selector for a given DOM element.
 */

/**
 * Build a unique CSS selector for an element.
 * Prefers id, then name attribute, then builds a positional path.
 */
export const UNIQUE_SELECTOR_FN = `
function _uniqueSelector(el) {
  if (el.id) return '#' + CSS.escape(el.id);
  if (el.name) {
    var byName = document.querySelectorAll(el.tagName + '[name="' + CSS.escape(el.name) + '"]');
    if (byName.length === 1) return el.tagName.toLowerCase() + '[name="' + CSS.escape(el.name) + '"]';
  }
  var path = [];
  var cur = el;
  while (cur && cur !== document.body) {
    var tag = cur.tagName.toLowerCase();
    var parent = cur.parentElement;
    if (parent) {
      var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === cur.tagName; });
      if (siblings.length > 1) {
        tag += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      }
    }
    path.unshift(tag);
    cur = parent;
  }
  return path.join(' > ');
}
`;
