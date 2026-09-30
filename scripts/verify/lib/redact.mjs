// Masks tokens and keys before anything reaches a log file or the console.

const JWT = /eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g;
const NAMED_SECRET = /((?:refresh_token|access_token|service_role_key|secret_key|password)["']?\s*[:=]\s*["']?)[^\s"'&,}]{8,}/gi;
const SUPABASE_KEY = /\bsb_(?:secret|publishable)_[\w-]{10,}/g;

export function redact(text) {
  return String(text)
    .replace(JWT, '<jwt>')
    .replace(SUPABASE_KEY, '<key>')
    .replace(NAMED_SECRET, '$1<redacted>');
}
