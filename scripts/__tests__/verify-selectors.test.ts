import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Fixtures: `old` is today's markup (classes copied from the components). `next` is redesigned
// markup with the data-cv-* hooks plus decoys: [data-decoy] elements and [data-decoy-class] class
// tokens that carry a legacy class next to (earlier than, or nearer than) the hooked element. The
// "new" variant strips the decoys; "mixed" keeps them. [data-expect~=<pair>] marks what a pair must
// resolve to, [data-from~=<pair>] where a closest() lookup starts, [data-root] the scope.

type Pair = { hook: string; legacy: string | null; probe?: string };
type Helpers = {
  usesHook(scope: ParentNode | null, pair: Pair): boolean;
  pickSelector(scope: ParentNode | null, hook: string, legacy: string | null, probe?: string): string | null;
  pickAll(scope: ParentNode | null, pair: Pair): Element[];
  pickOne(scope: ParentNode | null, pair: Pair, legacyScope?: ParentNode | null): Element | null;
  pickClosest(el: Element, scope: ParentNode, pair: Pair): Element | null;
};
type Device = { name: string; page: { evaluate(fn: unknown, arg?: unknown): Promise<unknown> } };
type Variant = 'old' | 'new' | 'mixed';
interface Screen { old: string; next: string }

// The harness is plain .mjs without type declarations.
const sel = (await import('../verify/lib/selectors.mjs' as string)) as {
  SELECTORS: Record<string, Pair>;
  SYNC_DIALOG: string;
  helpers: Helpers;
  inPage(fn: unknown, arg?: unknown): string;
  existsIn(d: Device, pair: Pair, opts?: { scope?: string }): Promise<boolean>;
  clickIn(d: Device, label: string | null, pair: Pair, opts?: { scope?: string; exact?: boolean; timeoutMs?: number }): Promise<string>;
};
const settings = (await import('../verify/lib/settings-flows.mjs' as string)) as {
  settingsOpen(d: Device): Promise<boolean>;
  readSyncTab(d: Device, o: { reopen: boolean }): Promise<Record<string, unknown>>;
  switchSettingsTab(d: Device, label: string): Promise<unknown>;
  saveSettings(d: Device): Promise<void>;
};
const backup = (await import('../verify/lib/backup-flows.mjs' as string)) as {
  localBackupRows(d: Device): Promise<unknown>;
  cloudBackupSection(d: Device): Promise<{ badge: string | null; toggleDisabled: boolean | null; text: string }>;
  pressCloudBackupToggle(d: Device): Promise<string>;
  clickToggleInPage(arg: { root: string; label: string }, cv: unknown): string;
};
const flows = (await import('../verify/lib/flows.mjs' as string)) as { openDialogs(d: Device): Promise<string[]> };
const syncFlows = (await import('../verify/lib/sync-flows.mjs' as string)) as {
  dialogDetails(d: Device): Promise<{ title: string; text: string }[]>;
  useVersionInReview(d: Device, field: string, value: string, o?: { timeoutMs?: number }): Promise<void>;
};
const panels = (await import('../verify/lib/sync-panels.mjs' as string)) as {
  recentlyDeletedItems(d: Device): Promise<unknown>;
  otherCopies(d: Device): Promise<unknown>;
  copyRowAction(d: Device, name: string, label: string): Promise<void>;
  massChangeDetails(d: Device): Promise<{ rows: unknown }>;
};
const forms = (await import('../verify/lib/ui-forms.mjs' as string)) as { banners(d: Device): Promise<unknown> };
const teams = (await import('../verify/lib/team-flows.mjs' as string)) as { openSidebar(d: Device): Promise<void> };
const passwords = (await import('../verify/lib/password-flows.mjs' as string)) as { unlockErrorLine(d: Device): Promise<string | null> };
const mcpSuite = (await import('../verify/suites/mcp.mjs' as string)) as { pickVersionNotInUseInPage(arg: null, cv: unknown): string | null };

const S = sel.SELECTORS;
const h = sel.helpers;
const VARIANTS: Variant[] = ['old', 'new', 'mixed'];
const all = (css: string) => [...document.querySelectorAll(css)];
const one = (css: string) => document.querySelector(css) as Element;
let clicks: string[] = [];

/** Runs code the way Playwright does: the function's source, evaluated in the page's global scope. */
const device: Device = {
  name: 'd',
  page: { evaluate: async (fn, arg) => (0, eval)(typeof fn === 'string' ? fn : `(${String(fn)})(${JSON.stringify(arg)})`) },
};

function render(screen: Screen, variant: Variant): void {
  document.body.innerHTML = variant === 'old' ? screen.old : screen.next;
  if (variant === 'new') {
    all('[data-decoy]').forEach((el) => el.remove());
    all('[data-decoy-class]').forEach((el) => el.classList.remove(...el.getAttribute('data-decoy-class')!.split(' ')));
  }
  clicks = [];
  all('[data-click]').forEach((el) => el.addEventListener('click', () => clicks.push(el.getAttribute('data-click')!)));
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) { return (this.textContent ?? '').replace(/\s+/g, ' ').trim(); },
  });
  Element.prototype.getClientRects = function (this: Element) {
    return (this.closest('[hidden]') ? [] : [{ x: 0, y: 0, width: 10, height: 10 }]) as unknown as DOMRectList;
  };
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  document.body.innerHTML = '';
});

const SETTINGS: Screen = {
  old: `<div class="fixed inset-0 z-50"><div data-dialog-content data-root class="w-full max-w-3xl">
  <div class="flex items-center justify-between px-4 py-3 border-b"><h2 class="text-lg font-semibold">Settings</h2><button class="p-1"><svg></svg></button></div>
  <div class="flex h-[500px]"><div class="w-52 border-r p-2">
    <button data-expect="settingsNavButton" class="w-full flex rounded text-sm"><svg></svg><span>General</span></button>
    <button data-expect="settingsNavButton" data-click="nav-backup" class="w-full flex rounded text-sm"><svg></svg><span>Backup</span></button>
    <button data-expect="settingsNavButton" class="w-full flex rounded text-sm"><svg></svg><span>Sync</span></button></div>
  <div class="flex-1 p-4"><div class="space-y-6">
    <div><h3 class="text-sm font-semibold">Multi-device sync</h3><p class="text-sm text-ink-muted px-1">Conduit merges changes from every device.</p>
      <p data-expect="syncPlan" class="text-xs text-ink-muted mt-2 px-1">Your plan: a vault can be open on one device at a time. Team vaults sync through your team.</p>
      <p data-expect="syncPaused" class="text-xs text-amber-400 mt-2 px-1">Conduit paused syncing for now.</p></div>
    <div><h3 class="text-sm font-semibold">This vault</h3><div class="space-y-3">
      <div data-expect="syncStatus" class="flex items-center justify-between p-3 rounded-lg bg-well border border-stroke-dim"><div>
        <p data-expect="syncStatusLabel" class="text-sm font-medium text-ink">Up to date</p><p data-expect="syncStatusDetail" class="text-xs text-ink-muted mt-0.5">Checked just now</p></div>
        <button type="button">Sync now</button></div>
      <div class="flex flex-wrap gap-2"><button type="button">Review changes</button><button type="button">Recently deleted</button></div>
      <div class="space-y-2"><div data-expect="syncNotice" class="flex items-start gap-2 p-2.5 rounded-md bg-amber-500/10 border"><svg></svg>
        <p data-expect="syncNoticeText" class="flex-1 text-xs">Another device deleted 12 items.</p><button type="button">Review</button><button type="button">OK</button></div></div></div></div>
    <div><h3 class="text-sm font-semibold">Devices</h3><div class="rounded-lg border divide-y divide-stroke-dim">
      <div data-expect="deviceRow" class="flex items-center gap-3 px-3 py-2"><svg></svg><div class="min-w-0"><p data-expect="deviceName" class="text-sm text-ink truncate">Mac Mini<span class="text-xs"> (this device)</span></p><p data-expect="deviceLine" class="text-xs truncate">Open now</p></div></div>
      <div data-expect="deviceRow" class="flex items-center gap-3 px-3 py-2"><svg></svg><div class="min-w-0"><p data-expect="deviceName" class="text-sm text-ink truncate">iPhone</p><p data-expect="deviceLine" class="text-xs truncate">Last seen 2 hours ago</p></div></div>
    </div></div></div></div></div>
  <div class="flex justify-end gap-2 px-4 py-3 border-t"><button data-expect="settingsFooterButton">Cancel</button><button data-expect="settingsFooterButton" data-click="save">Save</button></div>
</div></div>`,
  next: `<div class="fixed inset-0"><div data-dialog-content data-cv-settings data-root role="dialog" aria-labelledby="st">
  <div class="flex h-9 items-center"><h2 id="st">Settings</h2><div data-decoy class="w-52"><button data-click="decoy">Backup</button></div><button aria-label="Close">x</button></div>
  <div class="flex"><div class="w-52" data-cv-settings-nav>
    <button data-expect="settingsNavButton">General</button><button data-expect="settingsNavButton" data-click="nav-backup">Backup</button><button data-expect="settingsNavButton">Sync</button></div>
  <div class="flex-1"><section><h3>Multi-device sync</h3><p>Conduit merges changes from every device.</p>
      <p data-decoy class="text-xs">Your plan: an older line</p>
      <p data-cv-sync-plan data-expect="syncPlan" class="text-meta">Your plan: a vault can be open on one device at a time. Team vaults sync through your team.</p>
      <p data-decoy class="text-amber-400">Beta</p><p data-cv-sync-paused data-expect="syncPaused" class="text-warning">Conduit paused syncing for now.</p></section>
    <section><h3>This vault</h3><div data-decoy class="bg-well border"><p class="font-medium">Tip</p></div>
      <div data-cv-sync-status data-expect="syncStatus" class="flex bg-well border"><div>
        <p data-decoy class="font-medium">Status</p><p data-cv-sync-status-label data-expect="syncStatusLabel">Up to date</p>
        <p data-decoy class="text-xs">Personal vault</p><p data-cv-sync-status-detail data-expect="syncStatusDetail">Checked just now</p></div>
        <button type="button">Sync now</button></div>
      <div><button type="button">Review changes</button><button type="button">Recently deleted</button></div>
      <div data-decoy class="bg-amber-500/10"><p>Old notice style</p></div>
      <div data-cv-sync-notice data-expect="syncNotice" class="callout"><p data-decoy>Warning</p>
        <p data-cv-sync-notice-text data-expect="syncNoticeText">Another device deleted 12 items.</p><button type="button">Review</button><button type="button">OK</button></div></section>
    <section><h3>Devices</h3><div data-decoy class="divide-y"><div>Legend</div></div><div class="list">
      <div data-cv-device-row data-expect="deviceRow" class="row"><div><p data-decoy class="text-sm">Desktop</p><p data-cv-device-name data-expect="deviceName">Mac Mini<span> (this device)</span></p>
        <p data-decoy class="text-xs">macOS</p><p data-cv-device-line data-expect="deviceLine">Open now</p></div></div>
      <div data-cv-device-row data-expect="deviceRow" class="row"><div><p data-cv-device-name data-expect="deviceName">iPhone</p><p data-cv-device-line data-expect="deviceLine">Last seen 2 hours ago</p></div></div>
    </div></section></div></div>
  <div data-cv-dialog-footer class="flex justify-end"><button data-expect="settingsFooterButton">Cancel</button><button data-expect="settingsFooterButton" data-click="save">Save</button></div>
  <div data-decoy><button data-click="decoy">Save</button></div>
</div></div>`,
};

const BACKUP: Screen = {
  old: `<div data-dialog-content data-root><h2>Settings</h2><div class="w-52"><button>Backup</button></div><div class="space-y-4"><div class="space-y-3">
    <div data-expect="toggleRow" class="flex items-center justify-between"><div class="flex items-center gap-2"><svg></svg><label data-from="toggleRow" class="text-sm font-medium">Local Backup</label></div>
      <button data-expect="toggle" data-click="local-toggle" class="relative w-10 h-5 rounded-full"><span class="absolute"></span></button></div>
    <div class="flex items-center gap-2"><button class="px-3 py-1.5 text-xs">Backup Now</button></div>
    <div><label class="block text-xs font-medium mb-1">Backup Files (2)</label><div class="max-h-32 overflow-y-auto border rounded">
      <div data-expect="backupRow" class="flex items-center justify-between px-2 py-1.5 text-xs border-b last:border-b-0"><div class="flex-1 min-w-0"><span data-expect="backupName" class="text-ink-secondary truncate block">a.bak</span><span data-expect="backupMeta" class="text-[10px] text-ink-muted">9/28/2026 - 12 KB</span></div><button class="p-1"><svg></svg></button></div>
      <div data-expect="backupRow" class="flex items-center justify-between px-2 py-1.5 text-xs border-b last:border-b-0"><div class="flex-1 min-w-0"><span data-expect="backupName" class="text-ink-secondary truncate block">b.bak</span><span data-expect="backupMeta" class="text-[10px] text-ink-muted">9/27/2026 - 11 KB</span></div><button class="p-1"><svg></svg></button></div>
    </div></div><p class="text-xs">Backups are encrypted.</p></div>
  <div data-expect="cloudBackupSection" class="pt-4 border-t space-y-3">
    <div data-expect="toggleRow" class="flex items-center justify-between"><div class="flex items-center gap-2"><svg></svg><label data-from="toggleRow cloudBackupSection" class="text-sm font-medium">Cloud Backup</label>
      <span data-expect="cloudBackupBadge" class="px-1.5 py-0.5 text-[10px] rounded">Pro and Team</span></div>
      <button data-expect="toggle" disabled class="relative w-10 h-5 rounded-full"><span class="absolute"></span></button></div>
    <p class="text-xs">Cloud backup is available on Pro and Team plans.</p></div></div></div>`,
  next: `<div data-dialog-content data-cv-settings data-root role="dialog" aria-labelledby="st"><h2 id="st">Settings</h2><div class="w-52" data-cv-settings-nav><button>Backup</button></div><div>
    <div data-cv-toggle-row data-expect="toggleRow" class="grid justify-between"><div class="flex justify-between" data-decoy-class="justify-between"><label data-from="toggleRow">Local Backup</label></div>
      <button data-decoy data-click="decoy" aria-label="About local backup">?</button>
      <button data-cv-toggle="local" data-expect="toggle" data-click="local-toggle" role="switch"><span></span></button></div>
    <div><button>Backup Now</button></div>
    <div><label>Backup Files (2)</label><div data-cv-backup-files data-expect="backupFiles" class="rounded border">
      <div data-decoy class="border-b"><span class="block">Name</span><span class="text-[10px]">Created</span></div>
      <div data-cv-backup-row data-expect="backupRow" class="flex border-b"><div><span data-decoy class="block">icon</span><span data-cv-backup-name data-expect="backupName" class="block">a.bak</span>
        <span data-decoy class="text-[10px]">new</span><span data-cv-backup-meta data-expect="backupMeta">9/28/2026 - 12 KB</span></div><button aria-label="Delete">x</button></div>
      <div data-cv-backup-row data-expect="backupRow" class="flex"><div><span data-cv-backup-name data-expect="backupName">b.bak</span><span data-cv-backup-meta data-expect="backupMeta">9/27/2026 - 11 KB</span></div><button aria-label="Delete">x</button></div>
    </div></div>
    <div data-cv-cloud-backup-section data-expect="cloudBackupSection" class="border-t">
      <div data-cv-toggle-row data-expect="toggleRow" class="grid"><div class="flex space-y-3 justify-between" data-decoy-class="space-y-3 justify-between"><span data-decoy class="icon">c</span>
        <label data-from="toggleRow cloudBackupSection">Cloud Backup</label><span data-cv-cloud-backup-badge data-expect="cloudBackupBadge" class="badge">Pro and Team</span></div>
        <button data-cv-toggle="cloud" data-expect="toggle" role="switch" disabled><span></span></button></div>
      <p>Cloud backup is available on Pro and Team plans.</p></div></div></div>`,
};

const ERRORS: Screen = {
  old: `<div data-dialog-content class="w-full max-w-sm"><form><h2>Unlock Vault</h2><input placeholder="Enter master password">
    <div class="p-3 bg-red-500/10 border rounded"><p data-expect="dialogError unlockError" class="text-sm text-red-400">Wrong password</p></div><button type="submit">Unlock</button></form></div>
  <div data-dialog-content><h2>Change Password</h2><div class="flex items-start gap-2 p-3 rounded-md"><svg data-expect="unlockError" class="text-red-400"></svg>
    <p data-expect="dialogError" class="text-sm text-red-400">Current password is wrong</p></div></div>`,
  next: `<div data-dialog-content role="dialog" aria-labelledby="u"><form data-cv-dialog-form><h2 id="u">Unlock Vault</h2><input placeholder="Enter master password">
    <p data-decoy class="text-xs text-red-400">Caps Lock is on</p><div class="callout"><p data-cv-error data-expect="dialogError unlockError">Wrong password</p></div>
    <div data-cv-dialog-footer><button type="submit">Unlock</button></div></form></div>
  <div data-dialog-content><h2>Change Password</h2><div class="flex items-start gap-2 p-3 rounded-md"><svg data-expect="unlockError" class="text-red-400"></svg>
    <p data-expect="dialogError" class="text-sm text-red-400">Current password is wrong</p></div></div>`,
};

const versionLine = (value: string, inUse: boolean, decoy: boolean) => `<div data-line class="flex items-start gap-3 py-2${decoy ? ' rounded-md" data-decoy-class="rounded-md' : ''}">
  <div class="flex-1 min-w-0"><div class="flex items-start gap-2"><div class="min-w-0 flex-1">${decoy ? '<code data-decoy class="font-mono">v</code>' : ''}<span class="font-mono text-xs"${decoy ? ` data-cv-review-value` : ''} data-expect="reviewValue">${value}</span></div>
  ${inUse ? '<span class="px-1.5 rounded">In use now</span>' : ''}</div><p class="text-[11px]">Mac Mini, 2 min ago</p></div>
  <button data-from="reviewField" data-click="use-${value}" type="button"${decoy ? ' class="rounded-md" data-decoy-class="rounded-md"' : ''}>Use this</button></div>`;

const REVIEW: Screen = {
  old: `<div class="fixed inset-0 z-[60]"><div data-dialog-content data-root role="dialog" aria-modal="true" aria-label="Review changes">
    <div class="flex items-center justify-between px-4 py-3 border-b"><div class="flex items-center gap-2"><svg></svg><h2>Review changes</h2><span class="text-xs">1 item</span></div>
      <div class="flex gap-2"><button>Keep newest for all</button><button aria-label="Close"><svg></svg></button></div></div>
    <div class="flex-1 overflow-y-auto p-4"><div data-expect="reviewField" class="rounded-md border bg-well/40 p-3 space-y-2">
      <div class="flex items-center justify-between gap-2"><span data-expect="reviewFieldLabel" class="text-sm font-medium">Host</span><span class="text-[11px] text-amber-400">2 versions</span></div>
      <div>${versionLine('10.0.0.1', true, false)}${versionLine('10.0.0.2', false, false)}</div></div></div></div></div>`,
  next: `<div data-dialog-content data-root role="dialog" aria-label="Review changes"><h2>Review changes</h2><button aria-label="Close">x</button>
    <div data-cv-review-field data-expect="reviewField" class="card"><div class="flex"><span data-decoy class="icon">!</span>
      <span data-cv-review-field-label data-expect="reviewFieldLabel">Host</span><span>2 versions</span></div>
      <div>${versionLine('10.0.0.1', true, true)}${versionLine('10.0.0.2', false, true)}</div></div></div>`,
};

const SHELL_CLOSED: Screen = {
  old: `<div data-tabbar class="flex h-9"><button data-expect="sidebarOpener" data-click="opener" class="flex w-11" title="Open sidebar (Ctrl+B)"><div><span></span></div></button><div>Home</div></div>`,
  next: `<div data-cv-titlebar></div><div data-decoy data-tabbar><button data-click="decoy" title="Open sidebar (Ctrl+B)">=</button></div>
    <div data-cv-activitybar><button data-cv-activity data-cv-sidebar-toggle data-expect="sidebarOpener" data-click="opener" aria-expanded="false" title="Open sidebar (Ctrl+B)">V</button></div>`,
};

const SHELL_OPEN: Screen = {
  old: `<div data-sidebar-panel data-expect="sidebarOpen" class="fixed top-0"><div class="flex items-center justify-between p-3"><div class="flex items-center gap-1">
    <button data-expect="vaultSwitcher" title="Close sidebar (Ctrl+B)" aria-label="Close sidebar">x</button><button data-expect="vaultSwitcher" aria-pressed="false" title="Pin sidebar open (Ctrl+Shift+B)">p</button>
    <div class="relative"><button data-expect="vaultSwitcher" data-click="switcher" class="flex" title="/Users/me/Work.conduit">Work Vault<svg></svg></button></div></div>
    <div><button data-expect="vaultSwitcher reviewButton" data-click="review" title="Review changes from your other devices">2 to review</button></div></div></div>
    <div data-tabbar><button data-expect="vaultSwitcher" title="Close sidebar (Ctrl+B)">=</button></div>`,
  next: `<div data-decoy><button data-click="decoy" title="Review changes from your other devices">2 to review</button></div>
    <div data-cv-activitybar><button data-cv-sidebar-toggle aria-expanded="true" title="Close sidebar (Ctrl+B)">V</button></div>
    <div data-sidebar-panel data-expect="sidebarOpen"><div><button data-decoy data-click="decoy" title="Work Vault settings">Work Vault</button>
      <button data-cv-vault-switcher data-expect="vaultSwitcher" data-click="switcher" title="/Users/me/Work.conduit">Work Vault</button></div></div>
    <div data-cv-statusbar><button data-cv-status data-cv-review-button data-expect="reviewButton" data-click="review" title="Review changes from your other devices">2</button></div>`,
};

const BANNERS: Screen = {
  old: `<div class="flex items-center gap-2 px-4 py-1.5 border-b text-xs" role="status"><svg></svg><span data-expect="bannerText" class="flex-1 min-w-0">2 changes need review</span><button type="button">Review</button></div>
    <div class="flex items-center gap-2 border-b" role="status"><svg></svg><span data-expect="bannerText" class="flex-1 min-w-0">Vault file not found at /x.conduit</span><button type="button">Locate...</button><button type="button">Keep working on this device</button></div>`,
  next: `<div role="status" class="banner"><span data-decoy class="flex-1">i</span><span class="flex-1" data-cv-banner-text data-expect="bannerText">2 changes need review</span><button type="button">Review</button></div>
    <div role="status" class="banner"><span class="flex-1" data-cv-banner-text data-expect="bannerText">Vault file not found at /x.conduit</span><button type="button">Locate...</button><button type="button">Keep working on this device</button></div>`,
};

const DELETED: Screen = {
  old: `<div class="fixed inset-0 z-[60]"><div data-dialog-content data-root role="dialog" aria-modal="true" aria-label="Recently deleted">
    <div class="flex items-center gap-3"><div class="w-10 h-10 rounded-lg"><svg></svg></div><h2>Recently deleted</h2></div>
    <div class="px-6 pb-4 space-y-3 text-sm"><label class="flex items-center gap-2 text-xs"><input type="checkbox">Show items deleted more than 30 days ago</label>
      <div class="max-h-80 overflow-y-auto">
        <label data-expect="deletedRow" class="flex items-center gap-3 py-2 border-b"><input type="checkbox"><div class="flex-1 min-w-0"><p data-expect="deletedTitle" class="text-sm text-ink truncate">Old server</p><p data-expect="deletedDetail" class="text-xs text-ink-muted">Deleted 2 minutes ago · ssh</p></div></label>
        <label data-expect="deletedRow" class="flex items-center gap-3 py-2 opacity-60"><input type="checkbox" disabled><div class="flex-1 min-w-0"><p data-expect="deletedTitle" class="text-sm text-ink truncate"></p><p data-expect="deletedDetail" class="text-xs text-ink-muted">Erased permanently</p></div></label>
      </div></div>
    <div class="px-6 py-4 border-t flex"><button data-click="panel-delete">Delete permanently</button><button>Restore</button><button>Done</button></div></div></div>
  <div class="relative z-[70]"><div class="fixed inset-0 z-50"><div data-dialog-content><div class="px-6 py-4 border-b"><h2>Delete permanently?</h2></div><div class="px-6 py-4"><p>This erases the items.</p></div>
    <div class="px-6 py-4 border-t flex justify-end gap-3"><button data-expect="stackedConfirmButton">Cancel</button><button data-expect="stackedConfirmButton" data-click="confirm-delete">Delete permanently</button></div></div></div></div>`,
  next: `<div data-dialog-content data-root role="dialog" aria-label="Recently deleted"><h2>Recently deleted</h2>
    <label><input type="checkbox"><span>Show items deleted more than 30 days ago</span></label>
    <div data-decoy class="max-h-80"><label>Filter</label></div>
    <div data-cv-deleted-list class="max-h-80 overflow-y-auto">
      <label data-expect="deletedRow" class="row"><input type="checkbox"><div><p data-decoy class="text-sm">*</p><p data-cv-row-title data-expect="deletedTitle">Old server</p>
        <p data-decoy class="text-xs">ssh</p><p data-cv-row-detail data-expect="deletedDetail">Deleted 2 minutes ago · ssh</p></div></label>
      <label data-expect="deletedRow" class="row"><input type="checkbox" disabled><div><p data-cv-row-title data-expect="deletedTitle"></p><p data-cv-row-detail data-expect="deletedDetail">Erased permanently</p></div></label></div>
    <div data-cv-dialog-footer><button data-click="panel-delete">Delete permanently</button><button>Restore</button><button>Done</button></div></div>
  <div data-decoy class="z-[70]"><div data-dialog-content><h2>Other layer</h2><button data-click="decoy">Delete permanently</button></div></div>
  <div data-cv-layer="stacked"><div data-dialog-content role="dialog" aria-labelledby="c"><h2 id="c">Delete permanently?</h2><p>This erases the items.</p>
    <div data-cv-dialog-footer><button data-expect="stackedConfirmButton">Cancel</button><button data-expect="stackedConfirmButton" data-click="confirm-delete">Delete permanently</button></div></div></div>`,
};

const copyRowOld = (name: string, path: string, text: string) => `<div data-expect="copyRow copyRowOf" class="flex items-start gap-3 py-2.5 border-b border-stroke-dim last:border-b-0"><svg></svg>
  <div class="flex-1 min-w-0"><p data-from="copyRowOf" data-expect="copyTitle" class="text-sm text-ink truncate" title="${path}">${name}</p><p data-expect="copyDetail" class="text-xs text-ink-muted">${text}</p></div>
  <div class="flex gap-1.5"><button data-click="${name}:merge">Merge them...</button><button>Ignore</button></div></div>`;
const copyRowNew = (name: string, path: string, text: string) => `<div data-cv-copy-row data-expect="copyRow copyRowOf" class="row border-b"><svg></svg>
  <div class="flex items-start" data-decoy-class="flex items-start"><p data-decoy class="text-sm">f</p><p data-cv-row-title data-from="copyRowOf" data-expect="copyTitle" title="${path}">${name}</p>
    <p data-decoy class="text-xs">-</p><p data-cv-row-detail data-expect="copyDetail">${text}</p></div>
  <div><button data-click="${name}:merge">Merge them...</button><button>Ignore</button></div></div>`;

const COPIES: Screen = {
  old: `<div data-dialog-content data-root role="dialog" aria-modal="true" aria-label="Other copies of this vault"><div class="flex items-center gap-3"><h2>Other copies of this vault</h2></div>
    <div class="px-6 pb-4 space-y-3 text-sm"><div>${copyRowOld('Work (1).conduit', '/c/Work (1).conduit', 'A copy made by your cloud drive.')}${copyRowOld('Work.bak.conduit', '/c/Work.bak.conduit', 'An older copy.')}</div></div>
    <div class="px-6 py-4 border-t flex"><button><span>Scan again</span></button><button>Done</button></div></div>`,
  next: `<div data-dialog-content data-root role="dialog" aria-label="Other copies of this vault"><h2>Other copies of this vault</h2>
    <div data-decoy class="border-b"><p class="text-sm">Copies in this folder</p></div>
    <div>${copyRowNew('Work (1).conduit', '/c/Work (1).conduit', 'A copy made by your cloud drive.')}${copyRowNew('Work.bak.conduit', '/c/Work.bak.conduit', 'An older copy.')}</div>
    <div data-cv-dialog-footer><button>Scan again</button><button>Done</button></div></div>`,
};

const MASS: Screen = {
  old: `<div data-dialog-content role="dialog" aria-modal="true" aria-label="Mac Mini deleted 12 items."><h2>Mac Mini deleted 12 items.</h2><div class="px-6 pb-4 space-y-3 text-sm">
    <p>Undo only changes what you select.</p><div class="max-h-48 overflow-y-auto">
      <label data-root class="flex items-center gap-2 py-1 text-xs"><input type="checkbox" checked><span data-expect="massChangeTitle" class="text-ink">Server 1</span></label>
      <label data-root class="flex items-center gap-2 py-1 text-xs"><input type="checkbox" disabled><span data-expect="massChangeTitle" class="text-ink">Server 2</span><span class="text-ink-muted">(already back)</span></label></div></div></div>`,
  next: `<div data-dialog-content role="dialog" aria-label="Mac Mini deleted 12 items."><h2>Mac Mini deleted 12 items.</h2><p>Undo only changes what you select.</p>
    <label data-root class="checkbox"><input type="checkbox" checked><span data-decoy class="text-ink">x</span><span data-cv-row-title data-expect="massChangeTitle" class="text-ink">Server 1</span></label>
    <label data-root class="checkbox"><input type="checkbox" disabled><span data-cv-row-title data-expect="massChangeTitle">Server 2</span><span>(already back)</span></label></div>`,
};

interface PairCase {
  screen: Screen;
  mode: 'all' | 'first' | 'closest';
  scopes: () => ParentNode[];
  legacyScope?: () => ParentNode | null;
  /** Why the mixed fixture has no legacy decoy for this pair. */
  noDecoy?: string;
  /** The reader's text filter on top of the selector (B36). */
  filter?: (el: Element) => boolean;
}

const root = () => all('[data-root]');
const doc = () => [document];
const expected = (key: string) => () => all(`[data-expect~="${key}"]`);

const CASES: Record<string, PairCase[]> = {
  settingsNavButton: [{ screen: SETTINGS, mode: 'all', scopes: root }],
  settingsFooterButton: [{ screen: SETTINGS, mode: 'all', scopes: root }],
  syncStatus: [{ screen: SETTINGS, mode: 'first', scopes: root }],
  syncStatusLabel: [{ screen: SETTINGS, mode: 'first', scopes: expected('syncStatus') }],
  syncStatusDetail: [{ screen: SETTINGS, mode: 'first', scopes: expected('syncStatus') }],
  syncPlan: [{ screen: SETTINGS, mode: 'all', scopes: root, filter: (el) => (el.textContent ?? '').startsWith('Your plan:') }],
  deviceRow: [{ screen: SETTINGS, mode: 'all', scopes: root }],
  deviceName: [{ screen: SETTINGS, mode: 'first', scopes: expected('deviceRow') }],
  deviceLine: [{ screen: SETTINGS, mode: 'first', scopes: expected('deviceRow') }],
  syncNotice: [{ screen: SETTINGS, mode: 'all', scopes: root }],
  syncNoticeText: [{ screen: SETTINGS, mode: 'first', scopes: expected('syncNotice') }],
  syncPaused: [{ screen: SETTINGS, mode: 'all', scopes: root }],
  dialogError: [{ screen: ERRORS, mode: 'first', scopes: () => all('[data-dialog-content]') }],
  unlockError: [{ screen: ERRORS, mode: 'first', scopes: () => all('[data-dialog-content]') }],
  reviewField: [{ screen: REVIEW, mode: 'closest', scopes: root }],
  reviewFieldLabel: [{ screen: REVIEW, mode: 'first', scopes: expected('reviewField') }],
  reviewValue: [{ screen: REVIEW, mode: 'first', scopes: () => all('[data-line]') }],
  reviewButton: [{ screen: SHELL_OPEN, mode: 'all', scopes: doc }],
  bannerText: [{ screen: BANNERS, mode: 'first', scopes: () => all('[role=status]') }],
  sidebarOpener: [
    { screen: SHELL_CLOSED, mode: 'all', scopes: doc },
    { screen: SHELL_OPEN, mode: 'all', scopes: doc, noDecoy: 'nothing opens an open side bar' },
  ],
  sidebarOpen: [
    { screen: SHELL_OPEN, mode: 'all', scopes: doc },
    { screen: SHELL_CLOSED, mode: 'all', scopes: doc, noDecoy: 'a closed side bar has no panel' },
  ],
  vaultSwitcher: [{ screen: SHELL_OPEN, mode: 'all', scopes: doc }],
  deletedRow: [{ screen: DELETED, mode: 'all', scopes: root }],
  deletedTitle: [{ screen: DELETED, mode: 'first', scopes: expected('deletedRow') }],
  deletedDetail: [{ screen: DELETED, mode: 'first', scopes: expected('deletedRow') }],
  stackedConfirmButton: [{ screen: DELETED, mode: 'all', scopes: doc }],
  copyRow: [{ screen: COPIES, mode: 'all', scopes: root }],
  copyRowOf: [{ screen: COPIES, mode: 'closest', scopes: root }],
  copyTitle: [{ screen: COPIES, mode: 'first', scopes: expected('copyRow') }],
  copyDetail: [{ screen: COPIES, mode: 'first', scopes: expected('copyRow') }],
  massChangeTitle: [{ screen: MASS, mode: 'first', scopes: root }],
  toggleRow: [{ screen: BACKUP, mode: 'closest', scopes: root }],
  toggle: [{ screen: BACKUP, mode: 'first', scopes: expected('toggleRow') }],
  backupFiles: [{ screen: BACKUP, mode: 'first', scopes: root, noDecoy: 'the legacy half is structural (the label parent), read by localBackupRows' }],
  backupRow: [{ screen: BACKUP, mode: 'all', scopes: () => all('[data-cv-backup-files], .max-h-32') }],
  backupName: [{ screen: BACKUP, mode: 'first', scopes: expected('backupRow') }],
  backupMeta: [{ screen: BACKUP, mode: 'first', scopes: expected('backupRow') }],
  cloudBackupSection: [{ screen: BACKUP, mode: 'closest', scopes: root }],
  cloudBackupBadge: [{
    screen: BACKUP, mode: 'first', scopes: root,
    legacyScope: () => [...document.querySelectorAll('label')].find((l) => l.textContent === 'Cloud Backup')?.parentElement ?? null,
  }],
};

function render3(screen: Screen, variant: Variant) {
  render(screen, variant);
  return variant;
}

function resolveCase(key: string, c: PairCase, union = false): (Element | null)[] {
  const pair = S[key];
  const css = union ? `${pair.hook}, ${pair.legacy}` : null;
  const from = all(`[data-from~="${key}"]`);
  const scopes = c.scopes();
  if (c.mode === 'closest') return from.map((f) => (css ? f.closest(css) : h.pickClosest(f, scopes[0], pair)));
  if (c.mode === 'first') return scopes.map((s) => (css ? (c.legacyScope?.() ?? s).querySelector(css) : h.pickOne(s, pair, c.legacyScope?.() ?? s)));
  return scopes.flatMap((s) => (css ? [...s.querySelectorAll(css)] : h.pickAll(s, pair))).filter(c.filter ?? (() => true));
}

function wanted(key: string, c: PairCase): (Element | null)[] {
  if (c.mode === 'closest') return all(`[data-from~="${key}"]`).map((f) => f.closest(`[data-expect~="${key}"]`));
  return all(`[data-expect~="${key}"]`);
}

const same = (a: (Element | null)[], b: (Element | null)[]) => a.length === b.length && a.every((x, i) => x === b[i]);

describe('selector pairs (Appendix B)', () => {
  it('has fixtures for every pair and no pair without a hook', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(S).sort());
    for (const pair of Object.values(S)) expect(pair.hook).toMatch(/data-(cv|sidebar)-/);
  });

  for (const [key, cases] of Object.entries(CASES)) {
    cases.forEach((c, n) => {
      for (const variant of VARIANTS) {
        it(`${key} (${n + 1}) resolves on ${variant} markup`, () => {
          render3(c.screen, variant);
          const got = resolveCase(key, c).filter(Boolean);
          const want = wanted(key, c).filter(Boolean);
          expect(want.length > 0 || variant === 'old' || c.noDecoy !== undefined).toBe(true);
          expect(same(got, want)).toBe(true);
        });
      }
      if (!c.noDecoy && S[key].legacy) {
        it(`${key} (${n + 1}) mixed markup would fool a comma union`, () => {
          render3(c.screen, 'mixed');
          expect(same(resolveCase(key, c, true).filter(Boolean), wanted(key, c).filter(Boolean))).toBe(false);
        });
      }
    });
  }
});

describe('pickSelector', () => {
  it('uses the hook when the scope holds one, else the legacy selector', () => {
    document.body.innerHTML = '<div id="a"><p class="x">1</p></div><div id="b"><p class="x">2</p><p data-cv-y>3</p></div>';
    expect(h.pickSelector(one('#a'), '[data-cv-y]', 'p.x')).toBe('p.x');
    expect(h.pickSelector(one('#b'), '[data-cv-y]', 'p.x')).toBe('[data-cv-y]');
    expect(h.pickSelector(null, '[data-cv-y]', 'p.x')).toBe('p.x');
  });

  it('decides on the probe when one is given', () => {
    document.body.innerHTML = '<div id="a" data-cv-list><p class="x">legacy look</p></div>';
    expect(h.pickSelector(one('body'), '[data-cv-row]', 'p.x', '[data-cv-list]')).toBe('[data-cv-row]');
  });

  it('keeps closest() inside the scope', () => {
    document.body.innerHTML = '<div class="row"><section id="s"><button>b</button></section></div>';
    expect(h.pickClosest(one('button'), one('#s'), { hook: '[data-cv-row]', legacy: '.row' })).toBeNull();
  });

  it('ships as self-contained page code', () => {
    document.body.innerHTML = '<div id="a"><p class="x">1</p><p data-cv-y>2</p></div>';
    const fn = (arg: { id: string }, cv: Helpers & { S: Record<string, Pair> }) => cv.pickOne(document.getElementById(arg.id), { hook: '[data-cv-y]', legacy: 'p.x' })?.textContent;
    expect((0, eval)(sel.inPage(fn, { id: 'a' }))).toBe('2');
    expect((0, eval)(sel.inPage((_: null, cv: { S: Record<string, Pair> }) => Object.keys(cv.S).length))).toBe(Object.keys(S).length);
  });
});

describe('dialog detection (8.3)', () => {
  it('openDialogs and dialogDetails list only visible dialogs with an aria-label', async () => {
    document.body.innerHTML = `<div data-dialog-content role="dialog" aria-labelledby="t"><h2 id="t">Unlock Vault</h2></div>
      <div role="dialog" aria-label="Vault open on another device">Use here instead</div><div hidden role="dialog" aria-label="Gone">x</div>`;
    expect(sel.SYNC_DIALOG).toBe('[role=dialog][aria-label]');
    expect(await flows.openDialogs(device)).toEqual(['Vault open on another device']);
    expect(await syncFlows.dialogDetails(device)).toEqual([{ title: 'Vault open on another device', text: 'Use here instead' }]);
  });
});

describe('harness readers on old, new and mixed markup', () => {
  for (const variant of VARIANTS) {
    describe(variant, () => {
      it('Settings: root, Sync tab, nav and footer', async () => {
        render(SETTINGS, variant);
        expect(await settings.settingsOpen(device)).toBe(true);
        expect(all('[data-cv-settings]')).toEqual([one('[data-root]')]);
        const tab = await settings.readSyncTab(device, { reopen: false });
        expect({ ...tab, text: undefined }).toEqual({
          sections: ['Multi-device sync', 'This vault', 'Devices'],
          status: 'Up to date',
          detail: 'Checked just now',
          plan: 'Your plan: a vault can be open on one device at a time. Team vaults sync through your team.',
          devices: [{ name: 'Mac Mini (this device)', line: 'Open now' }, { name: 'iPhone', line: 'Last seen 2 hours ago' }],
          notices: [{ text: 'Another device deleted 12 items.', actions: ['Review', 'OK'] }],
          paused: ['Conduit paused syncing for now.'],
          text: undefined,
        });
        await settings.switchSettingsTab(device, 'Backup');
        one('[data-click=save]').addEventListener('click', () => one('[data-root]').remove());
        await settings.saveSettings(device);
        expect(clicks).toEqual(['nav-backup', 'save']);
      });

      it('Settings > Backup: rows, toggles and the Cloud Backup section', async () => {
        render(BACKUP, variant);
        expect(await backup.localBackupRows(device)).toEqual([{ name: 'a.bak', meta: '9/28/2026 - 12 KB' }, { name: 'b.bak', meta: '9/27/2026 - 11 KB' }]);
        const cloud = await backup.cloudBackupSection(device);
        expect([cloud.badge, cloud.toggleDisabled, cloud.text.includes('available on Pro and Team')]).toEqual(['Pro and Team', true, true]);
        expect(await backup.pressCloudBackupToggle(device)).toBe('disabled');
        expect((0, eval)(sel.inPage(backup.clickToggleInPage, { root: '[data-cv-settings]', label: 'Local Backup' }))).toBe('clicked');
        expect(clicks).toEqual(['local-toggle']);
      });

      it('dialog error lines', async () => {
        render(ERRORS, variant);
        expect(await passwords.unlockErrorLine(device)).toBe('Wrong password');
        expect(await sel.existsIn(device, S.unlockError, { scope: '[data-dialog-content]' })).toBe(true);
      });

      it('review panel: [Use this] by field and value, and the MCP suite pick', async () => {
        render(REVIEW, variant);
        await syncFlows.useVersionInReview(device, 'Host', '10.0.0.2', { timeoutMs: 2_000 });
        expect(clicks).toEqual(['use-10.0.0.2']);
        expect((0, eval)(sel.inPage(mcpSuite.pickVersionNotInUseInPage, null))).toBe('10.0.0.2');
      });

      it('side bar toggle, vault switcher and review button', async () => {
        render(SHELL_CLOSED, variant);
        one('[data-click=opener]').addEventListener('click', () => document.body.insertAdjacentHTML('beforeend', '<div data-sidebar-panel></div>'));
        await teams.openSidebar(device);
        expect(clicks).toEqual(['opener']);
        render(SHELL_OPEN, variant);
        await sel.clickIn(device, 'Work Vault', S.vaultSwitcher, { timeoutMs: 2_000 });
        await sel.clickIn(device, null, S.reviewButton, { timeoutMs: 2_000 });
        expect(clicks).toEqual(['switcher', 'review']);
      });

      it('banners', async () => {
        render(BANNERS, variant);
        expect(await forms.banners(device)).toEqual([
          { text: '2 changes need review', actions: ['Review'] },
          { text: 'Vault file not found at /x.conduit', actions: ['Locate...', 'Keep working on this device'] },
        ]);
      });

      it('Recently deleted rows and the stacked confirm', async () => {
        render(DELETED, variant);
        expect(await panels.recentlyDeletedItems(device)).toEqual([
          { title: 'Old server', detail: 'Deleted 2 minutes ago · ssh', checked: false, erased: false },
          { title: '', detail: 'Erased permanently', checked: false, erased: true },
        ]);
        await sel.clickIn(device, 'Delete permanently', S.stackedConfirmButton, { exact: true, timeoutMs: 2_000 });
        expect(clicks).toEqual(['confirm-delete']);
      });

      it('Other copies rows and a row action', async () => {
        render(COPIES, variant);
        expect(await panels.otherCopies(device)).toEqual([
          { name: 'Work (1).conduit', path: '/c/Work (1).conduit', text: 'A copy made by your cloud drive.', actions: ['Merge them...', 'Ignore'] },
          { name: 'Work.bak.conduit', path: '/c/Work.bak.conduit', text: 'An older copy.', actions: ['Merge them...', 'Ignore'] },
        ]);
        await panels.copyRowAction(device, 'Work.bak.conduit', 'Merge them...');
        expect(clicks).toEqual(['Work.bak.conduit:merge']);
      });

      it('mass change rows', async () => {
        render(MASS, variant);
        expect((await panels.massChangeDetails(device)).rows).toEqual([
          { title: 'Server 1', checked: true, disabled: false },
          { title: 'Server 2', checked: false, disabled: true },
        ]);
      });
    });
  }

  it('settingsOpen returns early on the data-cv-settings hook', async () => {
    document.body.innerHTML = '<div data-cv-settings><h3>General</h3></div><div data-dialog-content><h2>Settings</h2></div>';
    expect(await settings.settingsOpen(device)).toBe(true);
    expect(all('[data-cv-settings]')).toHaveLength(1);
  });
});
