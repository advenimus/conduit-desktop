import JSZip from 'jszip';
import { type Client, Users } from 'node-appwrite';
import type { Row } from '../api/filters.ts';
import type { FileStore } from '../api/storage.ts';
import type { Store } from '../api/store.ts';
import type { Effects } from '../api/triggers.ts';
import { rowIdFor } from '../api/codec.ts';
import { tableSpec } from '../schema/tables.ts';
import { syncVaultTeam } from './services.ts';

export interface EffectsEnv {
  RESEND_API_KEY?: string;
  RESEND_CONTACTS_API_KEY?: string;
  RESEND_SEGMENT_ID?: string;
  FEEDBACK_FROM?: string;
  FEEDBACK_TO?: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

async function resend(apiKey: string, path: string, payload: unknown): Promise<void> {
  const res = await fetch(`https://api.resend.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function fileBytes(store: Store, files: FileStore, path: string): Promise<Buffer | null> {
  const spec = tableSpec('cloud_files');
  const row = await store.get(spec, rowIdFor(spec, { bucket: 'feedback-logs', path }));
  return row ? files.get('feedback-logs', row.file_id as string) : null;
}

/** Port of the feedback-email-notify edge function. */
export async function sendFeedbackEmail(env: EffectsEnv, store: Store, files: FileStore, record: Row): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.warn('[feedback] RESEND_API_KEY not set; email skipped');
    return;
  }
  const zip = new JSZip();
  let hasAttachments = false;
  if (typeof record.log_file_path === 'string') {
    const bytes = await fileBytes(store, files, record.log_file_path);
    if (bytes) {
      zip.file('logs.txt', bytes);
      hasAttachments = true;
    }
  }
  const shots = Array.isArray(record.screenshot_paths) ? (record.screenshot_paths as string[]) : [];
  for (let i = 0; i < shots.length; i++) {
    const bytes = await fileBytes(store, files, shots[i]!);
    if (!bytes) continue;
    zip.file(`screenshot-${i}.${shots[i]!.split('.').pop() || 'png'}`, bytes);
    hasAttachments = true;
  }

  const isBug = record.type === 'bug';
  const prefix = isBug ? '[Conduit Bug]' : '[Conduit Feedback]';
  const createdAt = new Date(String(record.created_at)).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const si = (record.system_info ?? null) as Record<string, string> | null;
  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666;">${label}</td><td style="padding:4px 0;">${value}</td></tr>`;
  const section = (title: string) => `<tr><td colspan="2" style="padding:12px 0 4px 0;font-weight:bold;border-bottom:1px solid #ddd;">${title}</td></tr>`;
  const systemInfo =
    isBug && si
      ? section('System Info') +
        row('App Version', `Conduit v${escapeHtml(String(si.appVersion))}`) +
        row('Platform', `${escapeHtml(String(si.platform))} (${escapeHtml(String(si.arch))})`) +
        row('OS', escapeHtml(String(si.osVersion))) +
        row('Electron', escapeHtml(String(si.electronVersion))) +
        row('Node', escapeHtml(String(si.nodeVersion)))
      : '';
  const parts: string[] = [];
  if (shots.length) parts.push(`${shots.length} screenshot(s)`);
  if (record.log_file_path) parts.push('1 log file');
  const attachments = hasAttachments ? `${parts.join(', ')}, see attached zip` : 'None';

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;">
    <h2 style="margin:0 0 16px 0;color:#1a1a1a;">${prefix} ${escapeHtml(String(record.title))}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      ${row('Type', isBug ? 'Bug Report' : 'Feedback')}
      ${row('User', escapeHtml(String(record.user_email)))}
      ${row('Platform', escapeHtml(String(record.platform ?? 'unknown')))}
      ${row('App Version', escapeHtml(String(record.app_version ?? 'unknown')))}
      ${row('Submitted', createdAt)}
      ${section('Description')}
      <tr><td colspan="2" style="padding:8px 0;white-space:pre-wrap;">${escapeHtml(String(record.description))}</td></tr>
      ${systemInfo}
      ${section('Attachments')}
      <tr><td colspan="2" style="padding:8px 0;">${attachments}</td></tr>
    </table>
    <p style="margin-top:24px;font-size:12px;color:#999;">Feedback ID: ${escapeHtml(String(record.id))}</p>
  </div>`;

  const payload: Record<string, unknown> = {
    from: env.FEEDBACK_FROM ?? 'Conduit Bug Reports <bugs@conduitdesktop.com>',
    to: [env.FEEDBACK_TO ?? 'Conduit Support <support@conduitdesktop.com>'],
    subject: `${prefix} ${String(record.title)}`,
    html,
  };
  if (hasAttachments) {
    payload.attachments = [{ filename: `feedback-${String(record.id).split('-')[0]}.zip`, content: await zip.generateAsync({ type: 'base64' }) }];
  }
  await resend(env.RESEND_API_KEY, '/emails', payload);
}

/** Port of sync_email_to_resend: new users join the "Conduit Desktop Users" segment. */
export async function syncResendContact(env: EffectsEnv, client: Client, userId: string): Promise<void> {
  if (!env.RESEND_CONTACTS_API_KEY || !env.RESEND_SEGMENT_ID) return;
  const user = await new Users(client).get({ userId });
  if (!user.email) return;
  await resend(env.RESEND_CONTACTS_API_KEY, '/contacts', { email: user.email.toLowerCase(), segments: [{ id: env.RESEND_SEGMENT_ID }] });
}

export function appwriteEffects(env: EffectsEnv, client: Client, store: Store, files: FileStore): Effects {
  return {
    syncVaultMembership: (vaultId, userId, role) => syncVaultTeam(client, vaultId, userId, role),
    newUserProfile: async (userId) => {
      try {
        await syncResendContact(env, client, userId);
      } catch (e) {
        // A mailing-list hiccup must never block a signup.
        console.warn('[resend] contact sync failed:', e instanceof Error ? e.message : e);
      }
    },
    feedbackSubmitted: (row) => sendFeedbackEmail(env, store, files, row),
    fileReleased: (bucket, fileId) => files.delete(bucket, fileId),
  };
}
