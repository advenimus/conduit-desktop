import { create } from "zustand";
import { useSessionStore } from "./sessionStore";

/** Articles opened inside a dashboard tab (an asset's Info, a folder, the Knowledge page), like browser tabs. */
export interface ArticleTabs {
  open: string[];
  /** null shows the dashboard itself. */
  active: string | null;
}

interface ArticleTabsState {
  byHost: Record<string, ArticleTabs>;
  openTab: (host: string, articleId: string) => void;
  closeTab: (host: string, articleId: string) => void;
  activate: (host: string, articleId: string | null) => void;
  /** Drops an article from every host, for example after it was deleted. */
  closeEverywhere: (articleId: string) => void;
}

const EMPTY: ArticleTabs = { open: [], active: null };

export const useArticleTabsStore = create<ArticleTabsState>((set) => ({
  byHost: {},
  openTab: (host, articleId) =>
    set((s) => {
      const tabs = s.byHost[host] ?? EMPTY;
      const open = tabs.open.includes(articleId) ? tabs.open : [...tabs.open, articleId];
      return { byHost: { ...s.byHost, [host]: { open, active: articleId } } };
    }),
  closeTab: (host, articleId) =>
    set((s) => {
      const tabs = s.byHost[host] ?? EMPTY;
      const index = tabs.open.indexOf(articleId);
      if (index === -1) return s;
      const open = tabs.open.filter((id) => id !== articleId);
      // Like a browser: closing the active tab shows its neighbor, or the dashboard when none is left.
      const active = tabs.active === articleId ? (open[index] ?? open[index - 1] ?? null) : tabs.active;
      return { byHost: { ...s.byHost, [host]: { open, active } } };
    }),
  activate: (host, articleId) =>
    set((s) => ({ byHost: { ...s.byHost, [host]: { ...(s.byHost[host] ?? EMPTY), active: articleId } } })),
  closeEverywhere: (articleId) =>
    set((s) => {
      const byHost: Record<string, ArticleTabs> = {};
      for (const [host, tabs] of Object.entries(s.byHost)) {
        const open = tabs.open.filter((id) => id !== articleId);
        byHost[host] = { open, active: tabs.active === articleId ? (open[open.length - 1] ?? null) : tabs.active };
      }
      return { byHost };
    }),
}));

export const selectArticleTabs = (host: string) => (s: ArticleTabsState): ArticleTabs => s.byHost[host] ?? EMPTY;

// A closed dashboard tab forgets its articles, so reopening the asset starts clean.
useSessionStore.subscribe((state) => {
  const hosts = Object.keys(useArticleTabsStore.getState().byHost);
  const gone = hosts.filter((host) => !state.sessions.some((s) => s.id === host));
  if (gone.length === 0) return;
  useArticleTabsStore.setState((s) => {
    const byHost = { ...s.byHost };
    for (const host of gone) delete byHost[host];
    return { byHost };
  });
});
