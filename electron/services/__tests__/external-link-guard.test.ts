// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installExternalLinkGuard } from '../external-link-guard.js';

type OpenHandler = (details: { url: string }) => { action: 'deny' | 'allow' };

function fakeContents() {
  const emitter = new EventEmitter();
  let openHandler: OpenHandler | null = null;
  return {
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    setWindowOpenHandler: (handler: OpenHandler) => {
      openHandler = handler;
    },
    open: (url: string) => openHandler!({ url }),
  };
}

const isOwnUrl = (url: string) => url.startsWith('http://localhost:5173');

function setup() {
  const contents = fakeContents();
  const openExternal = vi.fn().mockResolvedValue(undefined);
  installExternalLinkGuard(contents, { isOwnUrl, openExternal });
  return { contents, openExternal };
}

describe('installExternalLinkGuard', () => {
  it('sends window.open urls to the system browser and denies the window', () => {
    const { contents, openExternal } = setup();
    expect(contents.open('https://example.com/x')).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://example.com/x');
  });

  it('denies window.open for unsafe schemes without opening anything', () => {
    const { contents, openExternal } = setup();
    expect(contents.open('javascript:alert(1)')).toEqual({ action: 'deny' });
    expect(contents.open('file:///etc/passwd')).toEqual({ action: 'deny' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('blocks navigation away from the app and opens web links externally', () => {
    const { contents, openExternal } = setup();
    const event = { preventDefault: vi.fn() };
    contents.emit('will-navigate', event, 'https://example.com/docs');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('blocks unsafe navigation without opening it', () => {
    const { contents, openExternal } = setup();
    const event = { preventDefault: vi.fn() };
    contents.emit('will-navigate', event, 'data:text/html,hi');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('lets the app navigate to its own pages', () => {
    const { contents, openExternal } = setup();
    const event = { preventDefault: vi.fn() };
    contents.emit('will-navigate', event, 'http://localhost:5173/#/home');
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('does not throw when openExternal rejects', async () => {
    const contents = fakeContents();
    const openExternal = vi.fn().mockRejectedValue(new Error('boom'));
    installExternalLinkGuard(contents, { isOwnUrl, openExternal });
    expect(() => contents.open('https://example.com')).not.toThrow();
    await Promise.resolve();
  });
});
