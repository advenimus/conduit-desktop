// Screenshots of the knowledge base screens, with an agent writing through the real MCP tools.
// Run from the repo root: node scripts/verify/capture-knowledge-screens.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { buildForRun, startVite } from './lib/app.mjs';
import { scenarioContext } from './lib/context.mjs';
import { createRunContext, freePort, installSignalHandlers } from './lib/run-context.mjs';
import { launchInMode } from './lib/restyle-flows.mjs';
import { createVault, enterLocalMode, refreshEntries, waitForScreen } from './lib/flows.mjs';
import { clickInTopDialog, setSidebar, vaultPath, withStores } from './lib/restyle-data.mjs';
import { captureWindow } from './lib/window-capture.mjs';
import { invoke, sleep, waitForText } from './lib/ui.mjs';

const OUT = path.resolve(process.argv[2] ?? '.verify/knowledge/screens');
const log = (m) => console.log(`[kb] ${m}`);
let seq = 0;
async function shot(d, name) {
  seq += 1;
  await sleep(500);
  const file = path.join(OUT, `${String(seq).padStart(2, '0')}-${name}.png`);
  await captureWindow(d, file, { method: 'page' });
  log(`saved ${path.basename(file)}`);
}

async function seed(ctx, d) {
  const folder = await invoke(d, 'folder_create', { name: 'Client Portal' });
  const web = await invoke(d, 'entry_create', { name: 'portal-web-01', entry_type: 'ssh', host: '10.70.0.11', port: 22, username: 'deploy', folder_id: folder.id, tags: ['ubuntu'] });
  const db = await invoke(d, 'entry_create', {
    name: 'portal-db-01', entry_type: 'ssh', host: '10.70.0.21', port: 22, folder_id: folder.id, tags: ['ubuntu'],
    notes: 'Postgres 16 primary.\n\n## Backups\nNightly pg_dump to /srv/backups, kept 14 days.\n\n## Failover\n1. Promote the replica\n2. Point the app at it\n3. Rebuild the old primary\n\n## Contacts\nDBA on call: Dana',
  });
  await invoke(d, 'kb_create', { scope: 'asset', entry_id: web.id, kind: 'overview', title: 'Overview', content: '# portal-web-01\n\nNginx front end for the client portal. Ubuntu 24.04, 4 vCPU.\n\n- App runs as **portal** under systemd\n- TLS certs renew with certbot' });
  await invoke(d, 'kb_create', { scope: 'folder', folder_id: folder.id, kind: 'facts', title: 'Portal network', content: '| Item | Value |\n| --- | --- |\n| VLAN | 30 |\n| Gateway | 10.70.0.254 |\n| VPN | Client Portal site-to-site |' });
  await refreshEntries(d);

  const mcp = await ctx.connectMcp(d);
  const call = async (tool, args) => {
    const r = await mcp.callToolRaw(tool, args);
    if (r.isError) throw new Error(`${tool}: ${r.text.slice(0, 200)}`);
    return r.data;
  };
  const steps = await call('kb_write', { scope: 'asset', entry_id: web.id, kind: 'procedure', title: 'Restart the web stack', summary: 'Safe restart order for nginx and the app', content: '## Steps\n1. systemctl restart portal\n2. systemctl restart nginx\n3. curl -fsS https://portal.example.com/health' });
  await sleep(1100);
  await call('kb_write', { article_id: steps.id, edits: [{ old_string: '2. systemctl restart nginx', new_string: '2. systemctl reload nginx (keeps open connections)' }], reason: 'reload avoids dropping connections' });
  await call('kb_write', { scope: 'asset', entry_id: web.id, kind: 'troubleshooting', title: 'Disk fills from /var/log', summary: 'Logrotate was missing for the app logs', content: '## Symptom\nDisk 100%, nginx 502s.\n\n## Cause\nNo logrotate rule for /var/log/portal.\n\n## Fix\nAdded /etc/logrotate.d/portal (daily, keep 7).' });
  await call('kb_write', { scope: 'asset', entry_id: web.id, kind: 'facts', title: 'Access', content: 'Local admin: !!Sw0rdfish-Portal-7!!\nSSH key: deploy@portal' });
  await call('kb_log', { entry_id: web.id, text: 'Added logrotate rule for /var/log/portal' });
  await call('kb_log', { entry_id: web.id, text: 'Switched nginx restarts to reloads' });
  await call('kb_write', { scope: 'vault', kind: 'playbook', title: 'Ubuntu patching', tags: ['Ubuntu'], summary: 'Monthly patch routine', content: '## Steps\n1. apt update && apt upgrade -y\n2. Reboot in the maintenance window\n3. Check services' });
  await mcp.close?.();
  await refreshEntries(d);
  return { folder: folder.id, web: web.id, db: db.id, steps: steps.id };
}

const open = (d, fn, arg, label) => withStores(d, fn, arg, { label });

async function screens(ctx, d) {
  await enterLocalMode(d);
  await createVault(d, vaultPath(d, 'Acme'), 'kb-capture-pw-1');
  await waitForScreen(d, 'main');
  const ids = await seed(ctx, d);
  await setSidebar(d, 'docked');

  await open(d, async (id) => (await import('/src/lib/openDashboard.ts')).openDashboardForEntry(id), ids.web, 'open web info');
  await waitForText(d, 'Restart the web stack');
  await shot(d, 'asset-knowledge-tab');

  await open(d, async (id) => (await import('/src/components/knowledge/kbUi.ts')).openArticle(id), ids.steps, 'open article');
  await waitForText(d, 'Review what changed?');
  await shot(d, 'article-review-banner');
  await d.page.evaluate(() => [...document.querySelectorAll('[role=status] button')].find((b) => b.textContent.trim() === 'Review' && b.getClientRects().length > 0)?.click());
  await waitForText(d, 'Review changes by');
  await shot(d, 'review-dialog');
  await clickInTopDialog(d, 'Keep');
  await sleep(400);
  await d.page.evaluate(() => document.querySelector('[aria-label="History"]')?.click());
  await waitForText(d, 'History of');
  await shot(d, 'history-dialog');
  await d.page.keyboard.press('Escape');

  await open(d, async (id) => (await import('/src/lib/openDashboard.ts')).openFolderView(id), ids.folder, 'open folder');
  await waitForText(d, 'Shared with');
  await shot(d, 'folder-knowledge');

  await open(d, async () => (await import('/src/lib/openDashboard.ts')).openKnowledgeView(), null, 'open knowledge view');
  await waitForText(d, 'that agents and you keep');
  await shot(d, 'vault-knowledge');

  await open(d, async (id) => (await import('/src/lib/openDashboard.ts')).openDashboardForEntry(id), ids.db, 'open db info');
  await waitForText(d, 'These notes look like a knowledge base');
  await shot(d, 'migration-banner');

  await open(d, async () => (await import('/src/lib/openHome.ts')).openHome(), null, 'open home');
  await waitForText(d, 'Agent learnings');
  await shot(d, 'home-agent-learnings');
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const run = createRunContext();
  installSignalHandlers(run);
  const step = (m) => log(m);
  step.file = (name) => run.logPath(name);
  let code = 0;
  try {
    const mainJs = await buildForRun(run);
    const vite = await startVite(run, await freePort());
    const { ctx, close } = scenarioContext({ run, env: { mainJs, devServerUrl: vite.url }, step });
    try {
      const d = await launchInMode(ctx, 'kb', 'light');
      try {
        await screens(ctx, d);
      } catch (err) {
        code = 1;
        log(`FAILED ${err.stack ?? err.message}`);
        await captureWindow(d, path.join(OUT, 'zz-failure.png'), { method: 'page' }).catch(() => {});
      }
      await ctx.quitDevice(d);
    } finally {
      await close();
    }
  } catch (err) {
    code = 2;
    log(`run stopped: ${err.stack ?? err.message}`);
  } finally {
    await run.runCleanup();
  }
  return code;
}

main().then((c) => process.exit(c));
