import { useState, useEffect, useCallback } from 'react';
import type { ReleaseNotesManifest, ReleaseEntry } from '../../types/whats-new';

const MANIFEST_URL =
  'https://raw.githubusercontent.com/advenimus/conduit-desktop/main/release-notes/manifest.json';
const MEDIA_BASE =
  'https://raw.githubusercontent.com/advenimus/conduit-desktop/main/release-notes';

export function getMediaUrl(version: string): string {
  return `${MEDIA_BASE}/v${version}/demo.gif`;
}

interface ReleaseNotesResult {
  releases: ReleaseEntry[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

// Module-level cache — only fetches once per session
let cachedReleases: ReleaseEntry[] | null = null;
let cachedError: string | null = null;
let fetchPromise: Promise<void> | null = null;

function isValidManifest(data: unknown): data is ReleaseNotesManifest {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  if (obj.schema_version !== 1) return false;
  if (!Array.isArray(obj.releases)) return false;
  return obj.releases.every(
    (r: unknown) =>
      r &&
      typeof r === 'object' &&
      typeof (r as Record<string, unknown>).version === 'string' &&
      typeof (r as Record<string, unknown>).title === 'string' &&
      Array.isArray((r as Record<string, unknown>).highlights)
  );
}

async function fetchManifest(): Promise<void> {
  // Cache-bust with timestamp to avoid GitHub CDN stale responses
  const url = `${MANIFEST_URL}?_t=${Date.now()}`;
  console.log('[whats-new] Fetching manifest:', url);
  try {
    const res = await fetch(url, { cache: 'no-store' });
    console.log('[whats-new] Response status:', res.status);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: unknown = await res.json();
    console.log('[whats-new] Parsed data:', JSON.stringify(data).slice(0, 200));
    if (!isValidManifest(data)) {
      console.warn('[whats-new] Invalid manifest format');
      throw new Error('Invalid manifest format');
    }
    cachedReleases = data.releases.slice(0, 5);
    cachedError = null;
    console.log('[whats-new] Loaded', cachedReleases.length, 'releases');
  } catch (err) {
    cachedReleases = null;
    cachedError = err instanceof Error ? err.message : 'Failed to fetch release notes';
    console.error('[whats-new] Fetch error:', cachedError);
  }
}

export function useReleaseNotes(): ReleaseNotesResult {
  const [releases, setReleases] = useState<ReleaseEntry[]>(cachedReleases ?? []);
  const [loading, setLoading] = useState(cachedReleases === null && cachedError === null);
  const [error, setError] = useState<string | null>(cachedError);

  const doFetch = useCallback((force?: boolean) => {
    if (cachedReleases && !force) {
      console.log('[whats-new] Using cached releases:', cachedReleases.length);
      setReleases(cachedReleases);
      setLoading(false);
      setError(null);
      return;
    }

    // Reset cache for retry
    if (force) {
      console.log('[whats-new] Force retry — clearing cache');
      cachedReleases = null;
      cachedError = null;
      fetchPromise = null;
    }

    setLoading(true);
    setError(null);

    if (!fetchPromise) {
      fetchPromise = fetchManifest();
    }

    fetchPromise.then(() => {
      console.log('[whats-new] Fetch complete — releases:', cachedReleases?.length ?? 0, 'error:', cachedError);
      setReleases(cachedReleases ?? []);
      setError(cachedError);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    doFetch();
  }, [doFetch]);

  const retry = useCallback(() => doFetch(true), [doFetch]);

  return { releases, loading, error, retry };
}
