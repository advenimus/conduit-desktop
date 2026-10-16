// Masks tokens and keys before anything reaches a log file or the console.

const JWT = /eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g;
const NAMED_SECRET = /((?:refresh_token|access_token|session|session_secret|secret|api_key|service_secret|password)["']?\s*[:=]\s*["']?)[^\s"'&,}]{8,}/gi;
// Appwrite API keys (standard_<hex>, dynamic keys) and the service secret header value.
const APPWRITE_KEY = /\b(?:standard|dynamic)_[0-9a-f]{32,}\b/g;
const SERVICE_HEADER = /(x-conduit-service["']?\s*[:=]\s*["']?)[^\s"'&,}]{8,}/gi;

export function redact(text) {
  return String(text)
    .replace(JWT, '<jwt>')
    .replace(APPWRITE_KEY, '<key>')
    .replace(SERVICE_HEADER, '$1<redacted>')
    .replace(NAMED_SECRET, '$1<redacted>');
}
