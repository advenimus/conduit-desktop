// The knowledge base footage (What's New for 0.18.1): Claude Code writes articles through the real MCP
// tools, then the asset page, an agent edit under review, a secret chip, the folder and vault views.

import { prepareMain } from './promo-setup.mjs';
import { focusSessionTab } from './promo-data.mjs';
import { clickInTopDialog, withStores } from './restyle-data.mjs';
import { invoke, sleep, waitForText, withTimeout } from './ui.mjs';

const DEMO_FIXTURE_SECRET = 'demo-only-7731';

async function seedKnowledge(ctx, d, ids, folders) {
  await invoke(d, 'kb_create', {
    scope: 'asset', entry_id: ids.web, kind: 'overview', title: 'Overview',
    content: '# web-01\n\nNginx front end for the Acme storefront. Ubuntu 24.04, 4 vCPU.\n\n- The app runs as **acme** under systemd\n- TLS renews with certbot every 60 days',
  });
  await invoke(d, 'kb_create', {
    scope: 'folder', folder_id: folders.Production, kind: 'facts', title: 'Production network',
    content: '| Item | Value |\n| --- | --- |\n| VLAN | 10 |\n| Gateway | 10.0.10.1 |\n| DNS | 10.0.10.5 |',
  });

  const mcp = await ctx.connectMcp(d, { clientName: 'claude-code' });
  const call = async (tool, args) => {
    const r = await mcp.callToolRaw(tool, args);
    if (r.isError) throw new Error(`${tool}: ${r.text.slice(0, 200)}`);
    return r.data;
  };
  // Written by the user, then improved by the agent, so the review shows a real before and after.
  const steps = await invoke(d, 'kb_create', {
    scope: 'asset', entry_id: ids.web, kind: 'procedure', title: 'Restart the web stack', summary: 'Safe restart order for nginx and the app',
    content: '## Steps\n1. systemctl restart acme\n2. systemctl restart nginx\n3. curl -fsS https://shop.acme.example/healthz',
  });
  await sleep(1100);
  await call('kb_write', {
    article_id: steps.id, reason: 'reload keeps open connections',
    edits: [{ old_string: '2. systemctl restart nginx', new_string: '2. systemctl reload nginx (keeps open connections)' }],
  });
  await call('kb_write', {
    scope: 'asset', entry_id: ids.web, kind: 'troubleshooting', title: 'Disk fills from /var/log', summary: 'Logrotate was missing for the app logs',
    content: '## Symptom\nDisk at 100%, nginx returns 502.\n\n## Cause\nNo logrotate rule for /var/log/acme.\n\n## Fix\nAdded /etc/logrotate.d/acme (daily, keep 7).',
  });
  const access = await call('kb_write', {
    scope: 'asset', entry_id: ids.web, kind: 'facts', title: 'Access', summary: 'Logins for web-01',
    content: `| Account | Secret |\n| --- | --- |\n| Local admin | !!${DEMO_FIXTURE_SECRET}!! |\n| Deploy key | deploy@web-01 |`,
  });
  await call('kb_log', { entry_id: ids.web, text: 'Added a logrotate rule for /var/log/acme' });
  await call('kb_log', { entry_id: ids.web, text: 'Switched nginx restarts to reloads' });
  await call('kb_write', {
    scope: 'vault', kind: 'playbook', title: 'Ubuntu patching', pinned: true, summary: 'Monthly patch routine for every Ubuntu host',
    content: '## Steps\n1. apt update && apt upgrade -y\n2. Reboot in the maintenance window\n3. Check that services came back',
  });
  await mcp.close?.();
  await withStores(d, async (_, s) => {
    await s.entry.getState().loadAll();
    return true;
  }, null, { label: 'reload entries' });
  return { steps: steps.id, access: access.id };
}

const openInPage = (d, fn, arg, label) => withStores(d, fn, arg, { label });

async function kb(ctx, rec) {
  const { d, ids } = await prepareMain(ctx, 'pk', 'dark', { ssh: ['web'] });
  const folders = await withStores(d, (_, s) => Object.fromEntries(s.entry.getState().folders.map((f) => [f.name, f.id])), null, { label: 'folders' });
  const art = await seedKnowledge(ctx, d, ids, folders);

  await openInPage(d, async (id) => (await import('/src/lib/openDashboard.ts')).openDashboardForEntry(id), ids.web, 'open web-01 info');
  await waitForText(d, 'Restart the web stack');
  await rec.shot(d, {
    scene: 'kb', name: 'asset', description: 'web-01 info: Knowledge tab with the pinned overview, articles by kind and inherited ones',
    targets: [{ label: 'Knowledge panel', selector: '[data-cv-knowledge-panel]' }, { label: 'Restart article', selector: `[data-cv-kb-article="${art.steps}"]` }],
  });

  await openInPage(d, async (id) => (await import('/src/components/knowledge/kbUi.ts')).openArticle(id), art.steps, 'open the procedure');
  await waitForText(d, 'Review what changed?');
  const reviewButton = { label: 'Review', selector: '[role=status] button' };
  await rec.shot(d, { scene: 'kb', name: 'article-review', description: 'Article with the "Claude Code edited this" banner', targets: [reviewButton] });
  await withTimeout(d.page.evaluate(() => [...document.querySelectorAll('[role=status] button')].find((b) => b.textContent.trim() === 'Review' && b.getClientRects().length > 0)?.click()), 10_000, 'click Review');
  await waitForText(d, 'Review changes by');
  await rec.shot(d, { scene: 'kb', name: 'review-dialog', description: 'Review dialog: line diff, Undo changes or Keep', targets: [{ label: 'Keep', selector: '[role=dialog] button.bg-btn-primary' }] });
  await clickInTopDialog(d, 'Keep');
  await sleep(500);
  await rec.shot(d, { scene: 'kb', name: 'article-kept', description: 'Article after Keep: no banner' });

  await openInPage(d, async (id) => (await import('/src/components/knowledge/kbUi.ts')).openArticle(id), art.access, 'open Access');
  await waitForText(d, 'Local admin');
  const reveal = { label: 'Reveal', selector: '[data-cv-secret-chip] button[aria-label^="Reveal"]' };
  await rec.shot(d, { scene: 'kb', name: 'chip-hidden', description: 'Access article: the password is an encrypted chip', targets: [reveal] });
  await withTimeout(d.page.evaluate(() => document.querySelector('[data-cv-secret-chip] button[aria-label^="Reveal"]')?.click()), 10_000, 'reveal chip');
  await waitForText(d, DEMO_FIXTURE_SECRET);
  await rec.shot(d, { scene: 'kb', name: 'chip-revealed', description: 'The chip revealed in place' });

  await openInPage(d, async (id) => (await import('/src/lib/openDashboard.ts')).openFolderView(id), folders.Production, 'open Production');
  await waitForText(d, 'Shared with');
  await rec.shot(d, { scene: 'kb', name: 'folder', description: 'Production folder: entries beside the shared knowledge', targets: [{ label: 'Folder knowledge', selector: '[data-cv-folder-knowledge]' }] });

  await openInPage(d, async () => (await import('/src/lib/openDashboard.ts')).openKnowledgeView(), null, 'open Knowledge');
  await waitForText(d, 'that agents and you keep');
  await rec.shot(d, { scene: 'kb', name: 'vault', description: 'Vault Knowledge page with filters and the review queue' });

  await focusSessionTab(d, '__home__');
  await ctx.quitDevice(d);
}

export const KB_SCENES = { kb };
