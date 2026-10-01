// Footage for the "Conduit at a glance" film (conduit-promo-0.18/film/PLAN.md): real RDP, VNC and web
// sessions, an MCP client driving a terminal, and the locked vault. Run with --out pointing at
// footage/film. The RDP host and login come only from PROMO_RDP_HOST, PROMO_RDP_USER and PROMO_RDP_PASS.

import sharp from 'sharp';
import { lockVault, refreshEntries } from './flows.mjs';
import { connectMcp } from './mcp.mjs';
import { openEntry, selectEntry, withStores } from './restyle-data.mjs';
import { prepareMain } from './promo-setup.mjs';
import { focusSessionTab } from './promo-data.mjs';
import { SCALE } from './promo-capture.mjs';
import { startMockVnc } from './promo-vnc.mjs';
import { clickText, invoke, mainEval, sleep, waitFor, withTimeout } from './ui.mjs';

const STATUS_HOST = 'status.acme.example';

async function waitConnected(d, entryId, label, timeoutMs = 45_000) {
  return waitFor(() => withStores(d, (id, s) => {
    const found = s.session.getState().sessions.find((x) => x.entryId === id && x.status === 'connected');
    return found ? found.id : null;
  }, entryId), { timeoutMs, label: `${d.name}: ${label} connected` });
}

async function rdp(ctx, rec) {
  const host = process.env.PROMO_RDP_HOST;
  const username = process.env.PROMO_RDP_USER;
  const password = process.env.PROMO_RDP_PASS;
  if (!host || !username || !password) throw new Error('set PROMO_RDP_HOST, PROMO_RDP_USER and PROMO_RDP_PASS');
  const { d, ids } = await prepareMain(ctx, 'fr', 'dark', { ssh: ['web'] });
  await invoke(d, 'entry_update', { id: ids.dc, host, username, password, credential_id: null });
  await refreshEntries(d);
  await sleep(400);
  await openEntry(d, ids.dc);
  await waitConnected(d, ids.dc, 'DC-01 (RDP)', 60_000);
  // Put the demo address back right away so nothing on screen shows the real host.
  await invoke(d, 'entry_update', { id: ids.dc, host: '10.0.10.5', username: 'svc-admin', password: '' });
  await refreshEntries(d);
  await selectEntry(d, ids.dc);
  await sleep(7000);
  const frame = () => rec.frame(d, { scene: 'f', name: 'rdp', description: 'Real RDP session to a Windows host inside Conduit', targets: [{ label: 'RDP canvas', selector: 'canvas' }] });
  for (let i = 0; i < 3; i++) {
    await frame();
    await sleep(300);
  }
  // No Start menu: it lists the host owner's recent documents and name.
  await rec.shot(d, { scene: 'f', name: 'rdp-still', description: 'RDP session, Windows desktop', targets: [{ label: 'RDP canvas', selector: 'canvas' }] });
  await ctx.quitDevice(d);
}

async function vnc(ctx, rec) {
  const { port } = await startMockVnc(ctx.run);
  const { d, ids } = await prepareMain(ctx, 'fv', 'dark', { ssh: ['web'] });
  await invoke(d, 'entry_update', { id: ids.mac, host: '127.0.0.1', port, password: '' });
  await refreshEntries(d);
  await sleep(400);
  await openEntry(d, ids.mac);
  await waitConnected(d, ids.mac, 'Build Mac (VNC)');
  await invoke(d, 'entry_update', { id: ids.mac, host: '10.0.30.7', port: 5900 });
  await refreshEntries(d);
  await selectEntry(d, ids.mac);
  await sleep(3000);
  await rec.shot(d, { scene: 'f', name: 'vnc', description: 'VNC session to an Ubuntu desktop (the remote screen is a mock)', targets: [{ label: 'VNC canvas', selector: 'canvas' }] });
  await ctx.quitDevice(d);
}

const STATUS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Acme Status</title><style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,Inter,Helvetica,Arial,sans-serif;background:#0f1115;color:#e6e8eb}
header{display:flex;align-items:center;gap:12px;padding:22px 40px;border-bottom:1px solid #222630}
.logo{width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,#22c55e,#0ea5e9)}
h1{font-size:20px;margin:0;font-weight:650}.ok{margin:28px 40px;padding:18px 22px;border-radius:12px;background:#0f2a1a;border:1px solid #1f5131;color:#86efac;font-weight:600;font-size:17px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:0 40px}
.card{background:#151821;border:1px solid #222630;border-radius:12px;padding:18px 20px}
.card h2{font-size:15px;margin:0 0 10px;color:#9aa3af;font-weight:600}.big{font-size:30px;font-weight:700}
.bars{display:flex;gap:3px;margin-top:14px}.bars i{flex:1;height:30px;border-radius:2px;background:#22c55e}.bars i.w{background:#f59e0b}
.rows{margin:24px 40px;background:#151821;border:1px solid #222630;border-radius:12px}
.row{display:flex;justify-content:space-between;padding:14px 20px;border-top:1px solid #222630;font-size:15px}.row:first-child{border-top:0}
.up{color:#22c55e;font-weight:600}</style></head><body>
<header><div class="logo"></div><h1>Acme Infrastructure Status</h1></header>
<div class="ok">All systems operational</div>
<div class="grid">
<div class="card"><h2>API uptime, 90 days</h2><div class="big">99.98%</div><div class="bars">${'<i></i>'.repeat(36)}<i class="w"></i>${'<i></i>'.repeat(8)}</div></div>
<div class="card"><h2>Median response</h2><div class="big">84 ms</div><div class="bars">${'<i></i>'.repeat(45)}</div></div>
<div class="card"><h2>Orders today</h2><div class="big">4,821</div><div class="bars">${'<i></i>'.repeat(45)}</div></div>
</div>
<div class="rows">
<div class="row"><span>web-01</span><span class="up">Operational</span></div>
<div class="row"><span>api-01</span><span class="up">Operational</span></div>
<div class="row"><span>db-01</span><span class="up">Operational</span></div>
<div class="row"><span>DC-01</span><span class="up">Operational</span></div>
</div></body></html>`;

/** Serves STATUS_PAGE for https://status.acme.example in the default session; everything else passes through. */
function serveStatusPage(d) {
  return mainEval(d, ({ session, net }, { host, html }) => {
    session.defaultSession.protocol.handle('https', (req) => {
      if (new URL(req.url).hostname === host) return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      return net.fetch(req, { bypassCustomProtocolHandlers: true });
    });
    return true;
  }, { host: STATUS_HOST, html: STATUS_PAGE }, { label: 'serve the status page' });
}

/** Page capture plus every visible native web view composited at its bounds (page captures leave them blank). */
async function shotWithViews(d, rec, opts) {
  const file = await rec.shot(d, opts);
  const views = await mainEval(d, async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.isVisible() && !w.webContents.getURL().includes('.html'));
    const out = [];
    for (const v of win.contentView.children) {
      if (!v.webContents || !v.getVisible?.() || v.webContents === win.webContents) continue;
      const b = v.getBounds();
      if (b.width < 50 || b.height < 50) continue;
      const img = await v.webContents.capturePage();
      out.push({ b, png: img.toPNG().toString('base64') });
    }
    return out;
  }, undefined, { label: 'capture web views' });
  const path = `${rec.outDir}/${file}`;
  const layers = await Promise.all(views.map(async ({ b, png }) => ({
    input: await sharp(Buffer.from(png, 'base64')).resize(b.width * SCALE, b.height * SCALE).png().toBuffer(),
    left: b.x * SCALE,
    top: b.y * SCALE,
  })));
  if (layers.length > 0) {
    const buf = await sharp(path).composite(layers).png().toBuffer();
    await sharp(buf).toFile(path);
  }
  console.log(`[promo] ${file}: ${layers.length} web view(s) composited`);
}

async function web(ctx, rec) {
  const { d, ids } = await prepareMain(ctx, 'fw', 'dark', { ssh: ['web'] });
  await serveStatusPage(d);
  await openEntry(d, ids.status);
  await waitConnected(d, ids.status, 'Status page (web)').catch(() => null);
  await selectEntry(d, ids.status);
  await sleep(4000);
  await shotWithViews(d, rec, { scene: 'f', name: 'web', description: 'Web session to the Acme status page (the page is a mock)', targets: [] });
  await ctx.quitDevice(d);
}

const AGENT_SCRIPT = 'for s in web-01 api-01 db-01; do printf "%-8s healthy\\n" $s; sleep 0.4; done; echo "3/3 services up"';

async function mcp(ctx, rec) {
  const { d } = await prepareMain(ctx, 'fm', 'dark', { ssh: ['web', 'db'] });
  const client = await connectMcp(d);
  const created = await client.callTool('local_shell_create', {});
  const shell = created.session_id ?? created.sessionId ?? created.id;
  if (!shell) throw new Error(`local_shell_create gave no session id: ${JSON.stringify(created).slice(0, 200)}`);
  await focusSessionTab(d, shell);
  await sleep(1500);
  // The shell would show this Mac's user and host name; give it the demo prompt and clear the screen first.
  for (const line of ["PROMPT='%F{green}ops@acme%f %F{blue}%~%f %# '", 'clear']) {
    await invoke(d, 'terminal_write', { sessionId: shell, data: [...Buffer.from(`${line}\r`)] });
    await sleep(500);
  }
  const frame = () => rec.frame(d, { scene: 'f', name: 'mcp', description: 'An AI agent runs commands in a Conduit terminal through MCP', targets: [{ label: 'Terminal', selector: '.xterm' }] });
  await frame();
  const run = client.callTool('terminal_execute', { connection_id: shell, command: AGENT_SCRIPT, timeout_ms: 20_000 });
  for (let i = 0; i < 12; i++) {
    await sleep(160);
    await frame();
  }
  await withTimeout(run, 30_000, 'terminal_execute');
  await sleep(600);
  await frame();
  await client.close?.();
  await ctx.quitDevice(d);
}

async function lock(ctx, rec) {
  const { d } = await prepareMain(ctx, 'fl', 'dark', { ssh: [] });
  await lockVault(d);
  await sleep(800);
  await rec.shot(d, { scene: 'f', name: 'hub-locked', description: 'Vault Hub after locking the vault', targets: [] });
  await clickText(d, 'Acme Infrastructure').catch(() => null);
  await sleep(1200);
  await rec.shot(d, { scene: 'f', name: 'unlock', description: 'Unlock the encrypted vault with the master password', targets: [{ label: 'Password', selector: 'input[type=password]' }] });
  await ctx.quitDevice(d);
}

export const FILM_SCENES = { 'f-rdp': rdp, 'f-vnc': vnc, 'f-web': web, 'f-mcp': mcp, 'f-lock': lock };
