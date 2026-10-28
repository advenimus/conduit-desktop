import { classifyTarget } from './open-target.js';

export interface ExternalLinkGuardDeps {
  isOwnUrl: (url: string) => boolean;
  openExternal: (url: string) => Promise<void>;
}

export interface GuardedContents {
  on(event: 'will-navigate', listener: (event: { preventDefault: () => void }, url: string) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): unknown;
}

/** Keeps the app window on its own pages: web links open in the system browser, everything else is dropped. */
export function installExternalLinkGuard(contents: GuardedContents, deps: ExternalLinkGuardDeps): void {
  const openInSystem = (rawUrl: string): void => {
    const target = classifyTarget(rawUrl);
    if (target?.kind !== 'url') return;
    deps.openExternal(target.url).catch((err) => {
      console.error('[external-link-guard] openExternal failed:', err);
    });
  };

  contents.setWindowOpenHandler(({ url }) => {
    openInSystem(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (deps.isOwnUrl(url)) return;
    event.preventDefault();
    openInSystem(url);
  });
}
