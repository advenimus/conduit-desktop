/**
 * MCP interaction methods for web sessions.
 *
 * Standalone functions extracted from WebSessionManager to keep
 * the manager file focused on session lifecycle and tab management.
 * Each function handles both WebView2 (via pipe) and Chromium (via
 * WebContentsView) code paths.
 */

import type { WebContentsView } from 'electron';
import type { WebView2Session } from './webview2-session.js';

// ──────────────────────────────────────────────────────────────
//  Click
// ──────────────────────────────────────────────────────────────

export function webClick(
  wv2: WebView2Session | undefined,
  view: WebContentsView | undefined,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle' = 'left',
  doubleClick = false,
): void {
  if (wv2) {
    const clickCount = doubleClick ? 2 : 1;
    const btnCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
    const init = JSON.stringify({ bubbles: true, clientX: x, clientY: y, button: btnCode });
    wv2.executeScript(`(function(){var el=document.elementFromPoint(${x},${y});if(el){for(var i=0;i<${clickCount};i++){el.dispatchEvent(new MouseEvent('click',${init}))}}})()`).catch(() => {});
    return;
  }

  if (!view) throw new Error('No webview available');
  const btnMap = { left: 'left', right: 'right', middle: 'middle' } as const;
  const electronBtn = btnMap[button] ?? 'left';

  view.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: electronBtn, clickCount: 1 });
  view.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: electronBtn, clickCount: 1 });

  if (doubleClick) {
    view.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: electronBtn, clickCount: 2 });
    view.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: electronBtn, clickCount: 2 });
  }
}

// ──────────────────────────────────────────────────────────────
//  Type text
// ──────────────────────────────────────────────────────────────

export async function webTypeText(
  wv2: WebView2Session | undefined,
  view: WebContentsView | undefined,
  text: string,
): Promise<void> {
  if (wv2) {
    await wv2.executeScript(
      `(function(){var el=document.activeElement;if(el&&(el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.isContentEditable)){document.execCommand('insertText',false,${JSON.stringify(text)})}})()`,
    );
    return;
  }

  if (!view) throw new Error('No webview available');
  await view.webContents.insertText(text);
}

// ──────────────────────────────────────────────────────────────
//  Send key
// ──────────────────────────────────────────────────────────────

export function webSendKey(
  wv2: WebView2Session | undefined,
  view: WebContentsView | undefined,
  key: string,
  modifiers: string[] = [],
  action: 'press' | 'down' | 'up' = 'press',
): void {
  if (wv2) {
    const mods = modifiers.map(m => m.toLowerCase());
    const eventInit = JSON.stringify({
      bubbles: true,
      key,
      ctrlKey: mods.includes('ctrl') || mods.includes('control'),
      shiftKey: mods.includes('shift'),
      altKey: mods.includes('alt'),
      metaKey: mods.includes('meta') || mods.includes('cmd'),
    });
    if (action === 'down' || action === 'press') {
      wv2.executeScript(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',${eventInit}))`).catch(() => {});
    }
    if (action === 'up' || action === 'press') {
      wv2.executeScript(`document.activeElement?.dispatchEvent(new KeyboardEvent('keyup',${eventInit}))`).catch(() => {});
    }
    return;
  }

  if (!view) throw new Error('No webview available');

  const electronModifiers: Array<'shift' | 'control' | 'alt' | 'meta'> = [];
  for (const m of modifiers) {
    const lower = m.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') electronModifiers.push('control');
    else if (lower === 'shift') electronModifiers.push('shift');
    else if (lower === 'alt') electronModifiers.push('alt');
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') electronModifiers.push('meta');
  }

  const keyCode = key as string;

  if (action === 'down' || action === 'press') {
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: electronModifiers });
  }
  if (action === 'up' || action === 'press') {
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: electronModifiers });
  }
}

// ──────────────────────────────────────────────────────────────
//  Mouse move
// ──────────────────────────────────────────────────────────────

export function webMouseMove(
  wv2: WebView2Session | undefined,
  view: WebContentsView | undefined,
  x: number,
  y: number,
): void {
  if (wv2) {
    wv2.executeScript(`(function(){var el=document.elementFromPoint(${x},${y});if(el)el.dispatchEvent(new MouseEvent('mousemove',${JSON.stringify({ bubbles: true, clientX: x, clientY: y })}))})()`).catch(() => {});
    return;
  }

  if (!view) throw new Error('No webview available');
  view.webContents.sendInputEvent({ type: 'mouseMove', x, y });
}

// ──────────────────────────────────────────────────────────────
//  Mouse drag
// ──────────────────────────────────────────────────────────────

export function webMouseDrag(
  wv2: WebView2Session | undefined,
  view: WebContentsView | undefined,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  button: 'left' | 'right' | 'middle' = 'left',
): void {
  if (wv2) {
    // WebView2: JS-emulated drag via dispatchEvent sequence
    const btnIdx = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
    const steps = 10;
    const moves = Array.from({ length: steps }, (_, i) => {
      const t = (i + 1) / steps;
      return `el.dispatchEvent(new MouseEvent('mousemove',{...init,clientX:${Math.round(fromX + (toX - fromX) * t)},clientY:${Math.round(fromY + (toY - fromY) * t)}}));`;
    }).join('');
    const script = `(function(){var el=document.elementFromPoint(${fromX},${fromY});if(!el)return;var init={bubbles:true,button:${btnIdx}};el.dispatchEvent(new MouseEvent('mousedown',{...init,clientX:${fromX},clientY:${fromY}}));${moves}el.dispatchEvent(new MouseEvent('mouseup',{...init,clientX:${toX},clientY:${toY}}));})()`;
    wv2.executeScript(script).catch(() => {});
    return;
  }

  if (!view) throw new Error('No webview available');

  const wc = view.webContents;
  const steps = 10;

  wc.sendInputEvent({ type: 'mouseMove', x: fromX, y: fromY });
  wc.sendInputEvent({ type: 'mouseDown', x: fromX, y: fromY, button, clickCount: 1 });

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ix = Math.round(fromX + (toX - fromX) * t);
    const iy = Math.round(fromY + (toY - fromY) * t);
    wc.sendInputEvent({ type: 'mouseMove', x: ix, y: iy, button });
  }

  wc.sendInputEvent({ type: 'mouseUp', x: toX, y: toY, button, clickCount: 1 });
}

// ──────────────────────────────────────────────────────────────
//  Mouse scroll
// ──────────────────────────────────────────────────────────────

export function webMouseScroll(
  wv2: WebView2Session | undefined,
  view: WebContentsView | undefined,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): void {
  if (wv2) {
    wv2.executeScript(`window.scrollBy(${deltaX},${deltaY})`).catch(() => {});
    return;
  }

  if (!view) throw new Error('No webview available');
  view.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX, deltaY });
}

// ──────────────────────────────────────────────────────────────
//  Fill input (CSS selector)
// ──────────────────────────────────────────────────────────────

export async function webFillInput(
  wv2: WebView2Session | undefined,
  view: WebContentsView | undefined,
  selector: string,
  value: string,
): Promise<boolean> {
  if (wv2) {
    const result = await wv2.executeScript(
      `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;var v=${JSON.stringify(value)};var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')||Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');if(s&&s.set){s.set.call(el,v)}else{el.value=v}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    );
    return result as boolean;
  }

  if (!view) throw new Error('No webview available');

  const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const escapedValue = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const result = await view.webContents.executeJavaScript(`(function() {
    var el = document.querySelector('${escaped}');
    if (!el) return false;
    var nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ) || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    );
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(el, '${escapedValue}');
    } else {
      el.value = '${escapedValue}';
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  return result as boolean;
}

// ──────────────────────────────────────────────────────────────
//  Get interactive elements
// ──────────────────────────────────────────────────────────────

const DISCOVER_ELEMENTS_SCRIPT = `(function(){var results={buttons:[],links:[],inputs:[],selects:[]};function getRect(el){var r=el.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}}function getText(el){return(el.innerText||el.textContent||'').trim().slice(0,100)}document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]').forEach(function(el){if(el.offsetParent===null)return;results.buttons.push({text:getText(el),selector:el.tagName.toLowerCase()+(el.id?'#'+el.id:''),bounds:getRect(el),disabled:el.disabled||false})});document.querySelectorAll('a[href]').forEach(function(el){if(el.offsetParent===null)return;results.links.push({text:getText(el),href:el.href,bounds:getRect(el)})});document.querySelectorAll('input,textarea').forEach(function(el){if(el.offsetParent===null)return;results.inputs.push({type:el.type||'text',name:el.name||'',placeholder:el.placeholder||'',selector:el.tagName.toLowerCase()+(el.id?'#'+el.id:''),value:el.value?'[filled]':'',bounds:getRect(el)})});document.querySelectorAll('select').forEach(function(el){if(el.offsetParent===null)return;var opts=Array.from(el.options).map(function(o){return{value:o.value,text:o.text,selected:o.selected}});results.selects.push({name:el.name||'',selector:el.tagName.toLowerCase()+(el.id?'#'+el.id:''),options:opts,bounds:getRect(el)})});return results})()`;

export async function webGetInteractiveElements(
  wv2: WebView2Session | undefined,
  view: WebContentsView | undefined,
): Promise<unknown> {
  if (wv2) return wv2.executeScript(DISCOVER_ELEMENTS_SCRIPT);
  if (!view) throw new Error('No webview available');
  return view.webContents.executeJavaScript(DISCOVER_ELEMENTS_SCRIPT);
}

// ──────────────────────────────────────────────────────────────
//  Execute JS
// ──────────────────────────────────────────────────────────────

export async function webExecuteJs(
  wv2: WebView2Session | undefined,
  view: WebContentsView | undefined,
  code: string,
): Promise<unknown> {
  if (wv2) return wv2.executeScript(code);
  if (!view) throw new Error('No webview available');
  return view.webContents.executeJavaScript(code);
}

// ──────────────────────────────────────────────────────────────
//  Read content
// ──────────────────────────────────────────────────────────────

export async function webReadContent(
  wv2: WebView2Session | undefined,
  view: WebContentsView | undefined,
  selector?: string,
  format?: string,
): Promise<string> {
  const fmt = format ?? 'text';
  let js: string;

  if (selector) {
    const safe = JSON.stringify(selector);
    js = fmt === 'html'
      ? `(function(){var el=document.querySelector(${safe});return el?el.outerHTML:''})()`
      : `(function(){var el=document.querySelector(${safe});return el?el.innerText:''})()`;
  } else {
    js = fmt === 'html' ? `document.documentElement.outerHTML` : `document.body.innerText`;
  }

  if (wv2) {
    const result = await wv2.executeScript(js);
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  if (!view) throw new Error('No webview available');
  return view.webContents.executeJavaScript(js);
}
