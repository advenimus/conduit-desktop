// The restyle suite's screens (docs/VISUAL_REDESIGN.md 8.6 step 5): the region each inventory reads,
// and the reference shots and inventory screens of each scenario. Regions use hooks and attributes
// that the restyle keeps (data-sidebar-panel, data-tabbar, data-content-area, data-dialog-content,
// titles and aria-labels), so the same region reads the layout before and after.

const WHOLE_WINDOW = null;
const SIDE_BAR = ['[data-sidebar-panel]'];
const TOP_DIALOG = [{ last: '[data-dialog-content]' }];

/** Inventory screens: name -> roots for captureInventory (null: the whole window). */
export const SCREENS = Object.freeze({
  'auth-screen': WHOLE_WINDOW,
  'vault-hub-empty': WHOLE_WINDOW,
  'vault-hub-with-recent': WHOLE_WINDOW,
  'vault-hub-with-recent-2': WHOLE_WINDOW,
  'unlock-dialog': TOP_DIALOG,
  'main-empty-vault-welcome': WHOLE_WINDOW,
  'sidebar-empty-vault-just-created': SIDE_BAR,
  'main-sidebar-local-mode': SIDE_BAR,
  'vault-switcher-menu-open': SIDE_BAR,
  'sidebar-search-active': SIDE_BAR,
  'sidebar-favorites-only': SIDE_BAR,
  'sidebar-signed-in': SIDE_BAR,
  'sidebar-sign-out-confirm': SIDE_BAR,
  'sidebar-cached-offline': WHOLE_WINDOW,
  'sidebar-team-vault': SIDE_BAR,
  'sidebar-trial-card': SIDE_BAR,
  'sidebar-trial-strip': SIDE_BAR,
  'main-tabbars-split-ai-open': ['[data-tabbar]'],
  'web-session-toolbar': [{ around: ['button[title="Back"]', 'button[title="Autofill"]'] }],
  'home-dashboard-full-window': WHOLE_WINDOW,
  'document-view-runbook': ['[data-content-area]'],
  'ai-panel': [{ around: ['button[title="Switch engine for this session"]', 'button[title="New conversation"]', 'textarea[aria-label="Terminal input"]'] }],
  'ai-panel-engine-menu-open': [{ around: ['button[title="Switch engine for this session"]', 'button[title="New conversation"]', 'textarea[aria-label="Terminal input"]'] }],
  'new-entry-dialog': TOP_DIALOG,
  'new-entry-ssh-form': TOP_DIALOG,
  'edit-entry-rdp-general': TOP_DIALOG,
  'edit-entry-rdp-credentials': TOP_DIALOG,
  'edit-entry-rdp-information': TOP_DIALOG,
  'edit-entry-rdp-display': TOP_DIALOG,
  'edit-entry-rdp-resources': TOP_DIALOG,
  'edit-entry-rdp-security': TOP_DIALOG,
  'new-folder-dialog': TOP_DIALOG,
  'quick-connect-dialog': TOP_DIALOG,
  'confirm-delete-dialog': TOP_DIALOG,
  'sync-panel-recently-deleted': TOP_DIALOG,
  'sync-panel-other-copies': TOP_DIALOG,
  'sync-panel-review-changes': ['[role=dialog][aria-label="Review changes"]'],
  ...Object.fromEntries(['general', 'appearance', 'security', 'sessions-terminal', 'sessions-ssh', 'sessions-rdp', 'sessions-vnc', 'sessions-web', 'ai', 'backup', 'sync', 'mobile', 'team', 'account'].map((t) => [`settings-${t}`, TOP_DIALOG])),
});

/** Menu screens, read from the popup window or the application menu. */
export const MENU_SCREENS = Object.freeze(['plus-popup', 'ctx-tab', 'ctx-tab-ssh-entry', 'ctx-tree-entry-ssh', 'ctx-tree-entry-web', 'ctx-tree-entry-credential', 'ctx-tree-folder', 'ctx-submenus', 'native-app-menu']);

/** Settings tabs in the order the scenario visits them: [nav label, screen suffix, reference shots]. */
export const SETTINGS_TABS = Object.freeze([
  ['General', 'general', ['20-settings-01-general']],
  ['Appearance', 'appearance', ['20-settings-02-appearance', '20-settings-02-appearance-part2']],
  ['Security', 'security', ['20-settings-03-security']],
  ['Sessions', 'sessions-terminal', ['20-settings-04-sessions-terminal', '20-settings-04-sessions-terminal-navscrolled']],
  ['SSH', 'sessions-ssh', ['20-settings-05-sessions-ssh']],
  ['RDP', 'sessions-rdp', ['20-settings-06-sessions-rdp', '20-settings-06-sessions-rdp-part2']],
  ['VNC', 'sessions-vnc', ['20-settings-07-sessions-vnc']],
  ['Web', 'sessions-web', ['20-settings-08-sessions-web']],
  ['AI', 'ai', ['20-settings-09-ai', '20-settings-09-ai-part2', '20-settings-09-ai-part3']],
  ['Backup', 'backup', ['20-settings-10-backup']],
  ['Sync', 'sync', ['20-settings-11-sync']],
  ['Mobile', 'mobile', ['20-settings-12-mobile']],
  ['Team', 'team', ['20-settings-13-team']],
  ['Account', 'account', ['20-settings-14-account']],
]);

/** Scenario -> the reference shots it must composite and the inventory screens it compares (8.6 step 5). */
export const SCENARIOS = Object.freeze({
  screens: {
    shots: ['00-auth-screen', '01-vault-hub-empty', '02-create-vault-dialog', '03-main-empty-vault', '03-main-empty-vault-sidebar-pinned', '41-vault-hub-recent-vaults', '42-unlock-vault-dialog'],
    screens: ['auth-screen', 'vault-hub-empty', 'vault-hub-with-recent', 'vault-hub-with-recent-2', 'unlock-dialog', 'main-empty-vault-welcome', 'sidebar-empty-vault-just-created'],
  },
  sidebar: {
    shots: ['04-sidebar-floating-open', '06-main-split-sidebar-floating', '07-main-split-sidebar-pinned', '08-zoom-sidebar-header', '09-zoom-sidebar-footer', '21-vault-switcher-menu', '38-sidebar-search-active', '39-sidebar-favorites-only'],
    screens: ['main-sidebar-local-mode', 'vault-switcher-menu-open', 'sidebar-search-active', 'sidebar-favorites-only'],
  },
  'sidebar-signed-in': {
    shots: ['44-sidebar-signed-in', '45-sidebar-sign-out-confirm', '46-sidebar-cached-offline', '47-sidebar-team-vault', '48-sidebar-trial-card', '49-sidebar-trial-strip'],
    screens: ['sidebar-signed-in', 'sidebar-sign-out-confirm', 'sidebar-cached-offline', 'sidebar-team-vault', 'sidebar-trial-card', 'sidebar-trial-strip'],
  },
  tabs: {
    shots: ['05-main-split-sidebar-closed', '06-main-split-sidebar-floating', '07-main-split-sidebar-pinned', '10-zoom-tabbars-split', '10b-zoom-tabbars-sidebar-closed', '40-home-dashboard-pinned', '43-document-view-runbook'],
    screens: ['main-tabbars-split-ai-open', 'web-session-toolbar', 'home-dashboard-full-window', 'document-view-runbook'],
  },
  ai: {
    shots: ['18-ai-panel-open', '19-ai-panel-engine-menu'],
    screens: ['ai-panel', 'ai-panel-engine-menu-open'],
  },
  menus: {
    shots: ['11-plus-newtab-popup', '12-zoom-plus-popup', '13-context-menu-tab', '14-context-menu-tree-entry', '15-context-menu-tree-folder', '16-context-menu-open-with-submenu', '17-context-menu-autotype-submenu'],
    screens: [...MENU_SCREENS],
  },
  settings: {
    shots: SETTINGS_TABS.flatMap(([, , shots]) => shots),
    screens: SETTINGS_TABS.map(([, suffix]) => `settings-${suffix}`),
  },
  dialogs: {
    shots: ['22-new-entry-dialog', '23-new-entry-ssh-form', '24-edit-entry-dialog-rdp-general', '25-edit-entry-dialog-rdp-credentials', '26-edit-entry-dialog-rdp-information', '27-edit-entry-dialog-rdp-display', '28-edit-entry-dialog-rdp-resources', '29-edit-entry-dialog-rdp-security', '30-new-folder-dialog', '31-quick-connect-dialog', '32-confirm-delete-dialog', '32b-confirm-delete-dialog-BUG-webview-covers-dialog', '33-sync-panel-recently-deleted', '34-sync-panel-other-copies', '35-sync-panel-review-changes'],
    screens: ['new-entry-dialog', 'new-entry-ssh-form', 'edit-entry-rdp-general', 'edit-entry-rdp-credentials', 'edit-entry-rdp-information', 'edit-entry-rdp-display', 'edit-entry-rdp-resources', 'edit-entry-rdp-security', 'new-folder-dialog', 'quick-connect-dialog', 'confirm-delete-dialog', 'sync-panel-recently-deleted', 'sync-panel-other-copies', 'sync-panel-review-changes'],
  },
  toasts: { shots: ['36-toasts', '37-zoom-toasts'], screens: [] },
  packs: { shots: [], screens: [] },
});

/** The roots of screen `name`; throws for a name the suite does not know. */
export function screen(name) {
  if (!Object.hasOwn(SCREENS, name)) throw new Error(`Unknown restyle screen "${name}"`);
  return { name, roots: SCREENS[name] };
}
