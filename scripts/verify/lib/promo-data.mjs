// The fictional "Acme Infrastructure" vault of the promo footage: folders, servers, databases, RDP hosts
// and web apps with sensible names, a few favorites, and live SSH sessions served by a local mock.

import { refreshEntries } from './flows.mjs';
import { startMockSsh } from './promo-ssh.mjs';
import { sleep, invoke, waitFor, withTimeout } from './ui.mjs';
import { openEntry, withStores } from './restyle-data.mjs';

const FOLDERS = ['Production', 'Staging', 'Databases', 'Office'];

// [key, name, folder, type, host, extra fields, favorite]
const ENTRIES = [
  ['admin', 'Domain Admin', null, 'credential', null, { username: 'svc-admin', password: 'Demo-Only-1', credential_type: 'password' }],
  ['pg', 'Postgres admin', null, 'credential', null, { username: 'postgres', password: 'Demo-Only-2', credential_type: 'password' }],
  ['db', 'db-01', 'Databases', 'ssh', '10.0.20.4', { port: 22, username: 'postgres' }],
  ['db2', 'db-02 (replica)', 'Databases', 'ssh', '10.0.20.5', { port: 22, username: 'postgres' }],
  ['redis', 'redis-cache', 'Databases', 'ssh', '10.0.20.9', { port: 22, username: 'redis' }],
  ['dc', 'DC-01', 'Production', 'rdp', '10.0.10.5', { port: 3389 }, true],
  ['fs', 'FS-01', 'Production', 'rdp', '10.0.10.6', { port: 3389 }],
  ['lb', 'lb-01', 'Production', 'ssh', '10.0.10.2', { port: 22, username: 'ops' }],
  ['api', 'api-01', 'Production', 'ssh', '10.0.10.12', { port: 22, username: 'deploy' }],
  ['web2', 'web-02', 'Production', 'ssh', '10.0.10.14', { port: 22, username: 'deploy' }],
  ['grafana', 'Grafana', 'Production', 'web', 'https://grafana.acme.example', {}, true],
  ['mac', 'Build Mac', 'Staging', 'vnc', '10.0.30.7', { port: 5900 }],
  ['stg', 'stg-web-01', 'Staging', 'ssh', '10.0.30.11', { port: 22, username: 'deploy' }],
  ['status', 'Status page', 'Staging', 'web', 'https://status.acme.example', {}],
  ['reception', 'Reception PC', 'Office', 'rdp', '10.0.40.21', { port: 3389 }],
  ['design', 'Design Mac', 'Office', 'vnc', '10.0.40.30', { port: 5900 }],
  ['nas', 'Synology NAS', 'Office', 'web', 'https://nas.acme.example:5001', {}],
  ['runbook', 'Runbook', null, 'document', null, { config: { content: '# Runbook\n\n- Check backups\n- Rotate keys\n- Patch Tuesday\n' } }],
  ['web', 'web-01', 'Production', 'ssh', '10.0.10.11', { port: 22, username: 'deploy' }, true],
];

const SSH_HISTORY = {
  web: {
    typing: 'sudo systemctl reload nginx',
    motd: 'Welcome to Ubuntu 24.04.2 LTS (GNU/Linux 6.8.0-52-generic x86_64)\r\n\r\n  System load:  0.21               Processes:             118\r\n  Usage of /:   41.3% of 58.1GB    Users logged in:       1\r\n  Memory usage: 34%                IPv4 address for eth0: 10.0.10.11',
    history: [
      { cmd: 'systemctl status nginx --no-pager | head -4', out: '\x1b[1;32m●\x1b[0m nginx.service - A high performance web server\r\n     Loaded: loaded (/lib/systemd/system/nginx.service; enabled)\r\n     Active: \x1b[1;32mactive (running)\x1b[0m since Mon 2026-09-28 06:12:41 UTC; 3 days ago\r\n   Main PID: 1182 (nginx)' },
      { cmd: 'tail -n 3 /var/log/nginx/access.log', out: '10.0.10.2 - - [01/Oct/2026:09:41:07] "GET /healthz HTTP/1.1" 200 2\r\n10.0.10.2 - - [01/Oct/2026:09:41:12] "GET /api/orders HTTP/1.1" 200 1840\r\n10.0.10.2 - - [01/Oct/2026:09:41:13] "GET /static/app.js HTTP/1.1" 304 0' },
    ],
  },
  db: {
    typing: 'psql -U postgres -d acme',
    motd: 'Welcome to Ubuntu 24.04.2 LTS (GNU/Linux 6.8.0-52-generic x86_64)',
    history: [
      { cmd: 'psql -c "select count(*) from orders;"', out: ' count \r\n-------\r\n 48213\r\n(1 row)\r\n' },
      { cmd: 'pg_isready', out: '/var/run/postgresql:5432 - accepting connections' },
    ],
  },
  api: {
    typing: 'docker logs -f api',
    motd: 'Welcome to Ubuntu 24.04.2 LTS (GNU/Linux 6.8.0-52-generic x86_64)',
    history: [{ cmd: 'docker ps --format "table {{.Names}}\\t{{.Status}}"', out: 'NAMES        STATUS\r\napi          Up 3 days (healthy)\r\nworker       Up 3 days' }],
  },
};

const create = async (device, fields) => {
  const entry = await invoke(device, 'entry_create', fields);
  await sleep(25);
  return entry;
};

/** Fills the open vault; returns {ids: {key: id}, folders: {name: id}}. Favorites are web-01, DC-01 and Grafana. */
export async function fillPromo(device) {
  const folders = {};
  for (const name of FOLDERS) folders[name] = (await invoke(device, 'folder_create', { name })).id;
  const ids = {};
  for (const [key, name, folder, type, host, extra, favorite] of ENTRIES) {
    const fields = { name, entry_type: type, ...(folder ? { folder_id: folders[folder] } : {}), ...(host ? { host } : {}), ...extra };
    if (key === 'dc' || key === 'fs') fields.credential_id = ids.admin;
    ids[key] = (await create(device, fields)).id;
    if (favorite) {
      await invoke(device, 'entry_update', { id: ids[key], is_favorite: true });
      await sleep(25);
    }
  }
  await refreshEntries(device);
  await withStores(device, async (_, s) => {
    await s.vault.getState().loadCredentials();
    return true;
  }, null, { label: 'reload credentials' });
  return { ids, folders };
}

/**
 * Opens the SSH entry `key` against a local mock server that plays its shell history, then puts the
 * entry's real address back so the app shows 10.0.x.x. Returns the session id.
 */
export async function openMockSsh(run, device, { ids, key }) {
  const entry = ENTRIES.find((e) => e[0] === key);
  const [, name, , , host] = entry;
  const user = entry[5].username;
  const server = await startMockSsh(run, { host: name.split(' ')[0], ...SSH_HISTORY[key] });
  await invoke(device, 'entry_update', { id: ids[key], host: '127.0.0.1', port: server.port });
  await refreshEntries(device);
  await sleep(400);
  await openEntry(device, ids[key]);
  const sessionId = await waitFor(() => withStores(device, (entryId, s) => {
    const found = s.session.getState().sessions.find((x) => x.entryId === entryId && x.status === 'connected');
    return found ? found.id : null;
  }, ids[key]), { timeoutMs: 30_000, label: `${device.name}: ${name} connected` });
  await sleep(900);
  await invoke(device, 'entry_update', { id: ids[key], host, port: 22, username: user });
  await refreshEntries(device);
  return sessionId;
}

/** Answers the Home dashboard channels from globalThis.__homeFixtures (the data layer is not built yet). */
export function installFakeHandlers(device, mainEval) {
  return mainEval(device, ({ ipcMain }) => {
    const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
    const fx = () => globalThis.__homeFixtures ?? { recent: [], ages: [], ai: [] };
    const channels = {
      connection_history_start: () => ({ id: `fake-${Date.now()}` }),
      connection_history_end: () => undefined,
      connection_history_recent: () => fx().recent.map((r) => ({ ...r, lastStartedAt: ago(r.min), lastEndedAt: null, lastDurationMs: null, count: r.count ?? 3 })),
      connection_history_for_entry: () => [],
      connection_history_clear: () => ({ deleted: 0 }),
      password_age_list: () => fx().ages.map((a) => ({ entryId: a.entryId, setAt: ago(a.min), source: 'created' })),
      ai_activity_recent: () => ({ items: fx().ai.map((a) => ({ ...a, at: ago(a.min), durationMs: a.ms ?? 180 })), logFound: true }),
      reachability_check: (_e, args) => ({ entryId: args?.entryId ?? '', status: 'not_checkable', host: null, port: null, latencyMs: null, checkedAt: ago(0) }),
    };
    for (const [channel, fn] of Object.entries(channels)) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, fn);
    }
    return true;
  }, undefined, { label: 'install fake dashboard handlers' });
}

const DAY = 60 * 24;

/** Recent connections, password ages and AI calls for the Home cards (minutes ago). */
export function homeFixtures(ids) {
  return {
    recent: [
      { entryId: ids.web, protocol: 'ssh', lastOutcome: 'open', min: 1, count: 14 },
      { entryId: ids.db, protocol: 'ssh', lastOutcome: 'open', min: 6, count: 9 },
      { entryId: ids.dc, protocol: 'rdp', lastOutcome: 'closed', min: 52, count: 5 },
      { entryId: ids.grafana, protocol: 'web', lastOutcome: 'closed', min: 190, count: 11 },
      { entryId: ids.mac, protocol: 'vnc', lastOutcome: 'closed', min: DAY + 40, count: 3 },
      { entryId: ids.api, protocol: 'ssh', lastOutcome: 'closed', min: 2 * DAY, count: 7 },
    ],
    ages: [
      { entryId: ids.admin, min: 400 * DAY },
      { entryId: ids.pg, min: 250 * DAY },
    ],
    ai: [
      { tool: 'terminal_execute', outcome: 'success', entryId: ids.web, sessionId: null, min: 2 },
      { tool: 'terminal_read', outcome: 'success', entryId: ids.db, sessionId: null, min: 4 },
      { tool: 'entry_list', outcome: 'success', entryId: null, sessionId: null, min: 11 },
      { tool: 'rdp_screenshot', outcome: 'success', entryId: ids.dc, sessionId: null, min: 24 },
      { tool: 'credential_read', outcome: 'access_denied', entryId: ids.admin, sessionId: null, min: 41 },
      { tool: 'terminal_execute', outcome: 'success', entryId: ids.api, sessionId: null, min: 63 },
    ],
  };
}

/** The renderer states Needs attention reads: a sync review of 2 values and a stale local backup. */
export function attentionState(device) {
  return withTimeout(device.page.evaluate(async () => {
    const { useSyncStore } = await import('/src/stores/syncStore.ts');
    const { useVaultStore } = await import('/src/stores/vaultStore.ts');
    const status = {
      lineageId: 'fake', fileName: 'Acme Infrastructure.conduit', kind: 'up-to-date', pauseReason: null, waiting: null,
      pendingPublish: false, unsyncedOps: 0, conflictCount: 2, lastSyncedMs: Date.now(), backoffUntilMs: null,
      sessionBadge: null, networkRoot: false, prompts: [], otherCopies: [],
    };
    useSyncStore.setState({ state: { enabled: true, killSwitch: false, vault: null, status, deviceLimit: null, sideFiles: [], notices: [], pendingVaults: [], softLocked: false, ownership: null, deviceCap: null } });
    useVaultStore.setState({
      localBackupState: { status: 'backed-up', lastBackedUpAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), error: null, enabled: true, backupPath: '/tmp', retentionDays: 7 },
    });
    return true;
  }), 15_000, `${device.name}: attention state`);
}

/** Makes session `id` the active tab of its pane (adding the Home tab first when it is missing). */
export function focusSessionTab(device, id) {
  return withStores(device, (sid, s) => {
    const { sessions, addSession } = s.session.getState();
    if (sid === '__home__' && !sessions.some((x) => x.id === sid)) addSession({ id: sid, type: 'dashboard', title: 'Home', status: 'connected' });
    const layout = s.layout.getState();
    const walk = (n) => (n.type === 'leaf' ? [n] : n.children.flatMap(walk));
    const pane = walk(layout.root).find((l) => l.sessionIds.includes(sid));
    layout.setFocusedPane(pane.id);
    layout.setActiveSessionInPane(pane.id, sid);
    return true;
  }, id, { label: `focus ${id}` });
}

/** Scrolls the visible Home page to its top. */
export function scrollHomeTop(device) {
  return withTimeout(device.page.evaluate(() => {
    const h1 = [...document.querySelectorAll('h1')].find((h) => h.textContent.startsWith('Welcome back') && h.getClientRects().length > 0);
    const scroller = h1?.closest('.overflow-y-auto');
    if (scroller) scroller.scrollTop = 0;
    return Boolean(scroller);
  }), 10_000, `${device.name}: scroll Home`);
}
